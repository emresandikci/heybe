import {
  type Expand,
  type Expr,
  type FindManyArgs,
  type ListResult,
  toAst,
  toExpand,
  toSort,
} from "@heybe/query";
import type { App } from "../app";
import { quote } from "../collections/ddl";
import type { Collection, Field } from "../collections/model";
import type { CollectionStore } from "../collections/store";
import type { Db } from "../db";
import { PasswordValue, fields } from "../fields";
import type { FieldCtx } from "../fields";
import { fileItems } from "../fields/file";
import { type PrepareCtx, toStr, uniqueStrings } from "../fields/shared";
import { type Filesystem, fileKey } from "../files/storage";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { parseSort } from "../filter/parse";
import type { RecordEvent } from "../hooks/events";
import { deleteModel, saveModel } from "../hooks/system";
import { NotFoundError, ValidationError, formatDate } from "../util";
import { expandRecords } from "./expand";
import { RecordModel } from "./model";
import { decode, managedIds } from "./read";
import { randomByPattern } from "./pattern";
import { serializeRecord } from "./serialize";

export interface RecordService<T> {
  findMany(args?: FindManyArgs<T>): Promise<ListResult<T>>;
  findOne(id: string, opts?: { expand?: Expand<T> }): Promise<T>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
}

export class StaleTokenError extends Error {}

type Values = Record<string, unknown>;
type Errors = Record<string, { code: string; message: string }>;

export interface PreparedWrite {
  ctx: PrepareCtx;
  // per field: submitted values (Files, plain passwords) and what they became (uploads, hashes)
  resolved: Map<string, Map<unknown, unknown>>;
  saved?: { saved: Values; original: Values | null };
}

export interface QueryOpts {
  filter?: Expr | null;
  sort?: string;
  page?: number;
  perPage?: number;
  skipTotal?: boolean;
  request?: RequestInfo | null;
  ruleFilter?: Expr | null;
  manageRule?: Expr | null;
  // decoded values instead of serialized records
  raw?: boolean;
}

interface Deps {
  db: Db;
  store: CollectionStore;
  files: Filesystem;
  now: () => Date;
}

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;
const CREATE_FAILED = "Failed to create record.";
const UPDATE_FAILED = "Failed to update record.";
const LIST_TYPES = ["select", "relation", "file"];

// used when the record id cannot be a storage path segment; such ids never pass validation
const DISCARD: Filesystem = {
  write: async () => {},
  file: async () => null,
  delete: async () => {},
  deletePrefix: async () => {},
};

const storableId = (id: string) =>
  id !== "" && id !== "." && id !== ".." && !/[/\\\0]/.test(id);

export function zeroValues(c: Collection): Values {
  return Object.fromEntries(
    c.fields.map((f) => [f.name, fields[f.type].normalize(undefined, f)]),
  );
}

export function modifier(
  f: Field,
  key: string,
): "set" | "append" | "prepend" | "subtract" | "autogenerate" | null {
  const list = LIST_TYPES.includes(f.type);
  if (key === f.name) return "set";
  if (key === f.name + "+" && (list || f.type === "number")) return "append";
  if (key === "+" + f.name && list) return "prepend";
  if (key === f.name + "-" && (list || f.type === "number")) return "subtract";
  if (key === f.name + ":autogenerate" && f.type === "text")
    return "autogenerate";
  return null;
}

export function applyModifier(
  f: Field,
  op: NonNullable<ReturnType<typeof modifier>>,
  current: unknown,
  input: unknown,
): unknown {
  const def = fields[f.type];
  if (op === "set") return def.normalize(input, f);
  if (op === "autogenerate") {
    const pattern =
      typeof f.autogeneratePattern === "string" ? f.autogeneratePattern : "";
    return toStr(input) + (pattern ? randomByPattern(pattern) : "");
  }
  if (f.type === "number") {
    const delta = def.normalize(input, f) as number;
    return (current as number) + (op === "append" ? delta : -delta);
  }
  const items = f.type === "file" ? fileItems : uniqueStrings;
  const old: unknown[] = items(current);
  const mod: unknown[] = items(input);
  if (op === "append") return def.normalize([...old, ...mod], f);
  if (op === "prepend") return def.normalize([...mod, ...old], f);
  return def.normalize(
    old.filter((v) => !mod.includes(v)),
    f,
  );
}

function assign(c: Collection, values: Values, data: Values): void {
  const keys = Object.keys(data).sort((a, b) => a.length - b.length);
  for (const key of keys) {
    for (const f of c.fields) {
      const op = modifier(f, key);
      if (!op) continue;
      if (f.type !== "autodate")
        values[f.name] = applyModifier(f, op, values[f.name], data[key]);
      break;
    }
  }
}

// The record values after loading `data` into `base` (a new record when null), without validation.
export function draftValues(
  c: Collection,
  base: Values | null,
  data: Values,
): Values {
  const values = { ...(base ?? zeroValues(c)) };
  assign(c, values, data);
  return values;
}

// Port of PB Record.ReplaceModifiers: modifier keys ("views+") become the resolved field value.
// Password values stay as submitted, so the plain text still reaches the record service.
export function replaceModifiers(
  c: Collection,
  base: Values | null,
  data: Values,
): Values {
  const values = draftValues(c, base, data);
  const out = { ...data };
  for (const key of Object.keys(data)) {
    const f = c.fields.find((f) => modifier(f, key));
    if (!f || f.type === "password") continue;
    delete out[key];
    out[f.name] = values[f.name];
  }
  return out;
}

export function dbValues(c: Collection, values: Values): unknown[] {
  return c.fields.map((f) => fields[f.type].toDb(values[f.name]));
}

function autogenerate(c: Collection, values: Values): void {
  for (const f of c.fields) {
    const pattern = f.type === "text" ? f.autogeneratePattern : "";
    if (typeof pattern === "string" && pattern !== "" && values[f.name] === "")
      values[f.name] = randomByPattern(pattern);
  }
}

// records what each submitted leaf became; prepare keeps the shape of arrays
function pair(pairs: Map<unknown, unknown>, input: unknown, output: unknown) {
  if (Array.isArray(input) && Array.isArray(output))
    input.forEach((v, i) => pair(pairs, v, output[i]));
  else if (input !== output) pairs.set(input, output);
}

const swap = (pairs: Map<unknown, unknown>, value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((v) => swap(pairs, v))
    : pairs.has(value)
      ? pairs.get(value)
      : value;

function insertSql(c: Collection, cols: string[]): string {
  return `INSERT INTO ${quote(c.name)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
}

// the prepare context of each record being saved, for values a hook sets that still need preparing
const preparing = new WeakMap<RecordModel, PreparedWrite>();

const valuesOf = (record: RecordModel): Values =>
  Object.fromEntries(
    record.collection.fields.map((f) => [f.name, record.get(f.name)]),
  );

function setValues(record: RecordModel, values: Values): void {
  for (const f of record.collection.fields)
    record.setRaw(f.name, values[f.name]);
}

// plain keys before their modifiers ("tags" before "tags+")
const byKeyLength = (data: Values): Values =>
  Object.fromEntries(
    Object.entries(data).sort(([a], [b]) => a.length - b.length),
  );

const needsPrepare = (f: Field, value: unknown): boolean =>
  f.type === "password"
    ? value instanceof PasswordValue && value.plain !== "" && value.hash === ""
    : f.type === "file" && fileItems(value).some((v) => v instanceof File);

export class RecordServiceImpl<T> {
  private readonly deps: Deps;

  constructor(
    private readonly app: App,
    private readonly name: string,
  ) {
    this.deps = {
      db: app.db,
      store: app.collections,
      files: app.files,
      now: app.now,
    };
  }

  async findMany(args: FindManyArgs<T> = {}): Promise<ListResult<T>> {
    const result = this.query({
      filter: args.where ? toAst<T>(args.where) : null,
      sort: toSort<T>(args.orderBy),
      page: args.page,
      perPage: args.perPage,
      skipTotal: args.count === false,
    });
    if (!args.expand) return result;
    return {
      ...result,
      items: await this.expand(this.collection(), result.items, args.expand),
    };
  }

  async findOne(id: string, opts: { expand?: Expand<T> } = {}): Promise<T> {
    const c = this.collection();
    const record = this.output(c, this.load(c, id));
    return opts.expand
      ? (await this.expand(c, [record], opts.expand))[0]!
      : record;
  }

  private async expand(
    c: Collection,
    items: T[],
    expand: Expand<T>,
  ): Promise<T[]> {
    const { db, store, now } = this.deps;
    return (await expandRecords(
      { db, collections: store, now },
      c,
      items as Values[],
      toExpand(expand as Expand<unknown>).split(","),
      null,
    )) as T[];
  }

  async create(data: Partial<T>): Promise<T> {
    const p = await this.prepare(data);
    return this.commit(p, () => this.createPrepared(p, data));
  }

  async update(id: string, data: Partial<T>): Promise<T> {
    const p = await this.prepare(data, id);
    return this.commit(p, () => this.updatePrepared(p, id, data));
  }

  async delete(id: string): Promise<void> {
    const p = await this.prepare({}, id);
    await this.commit(p, () => this.deletePrepared(p, id));
  }

  // The record id (given, `id:autogenerate` or generated) is fixed first: it names the storage dir.
  async prepare(data: Partial<T>, id?: string): Promise<PreparedWrite> {
    const c = this.writable();
    const input = data as Values;
    const p: PreparedWrite = {
      ctx: this.prepareCtx(c, id ?? this.newId(c, input)),
      resolved: new Map(),
    };
    try {
      for (const key of Object.keys(input)) {
        const f = c.fields.find((f) => modifier(f, key));
        const prepare = f && fields[f.type].prepare;
        if (!prepare || modifier(f, key) === "subtract") continue;
        const out = await prepare(input[key], f, p.ctx);
        let pairs = p.resolved.get(f.name);
        if (!pairs) p.resolved.set(f.name, (pairs = new Map()));
        pair(pairs, input[key], out);
      }
    } catch (e) {
      await this.settle(p);
      throw e;
    }
    return p;
  }

  async createPrepared(p: PreparedWrite, data: Partial<T>): Promise<T> {
    return this.savePrepared(p, this.draft(p, data));
  }

  // `tokenKey`: the one a token was checked against; the write fails when it changed since
  async updatePrepared(
    p: PreparedWrite,
    id: string,
    data: Partial<T>,
    opts: { tokenKey?: string } = {},
  ): Promise<T> {
    const c = this.writable();
    return this.savePrepared(p, this.draft(p, data, this.load(c, id)), opts);
  }

  // The record a prepared create (no `original`) or update of `original` saves.
  draft(p: PreparedWrite, data: Partial<T>, original?: Values): RecordModel {
    const c = this.writable();
    const input = this.resolve(p, data as Values);
    if (original) {
      const record = new RecordModel(c, original, false);
      record.load(byKeyLength(input));
      return record;
    }
    delete input["id:autogenerate"];
    input.id = p.ctx.recordId;
    return new RecordModel(c, byKeyLength(input));
  }

  async savePrepared(
    p: PreparedWrite,
    record: RecordModel,
    opts: { tokenKey?: string } = {},
  ): Promise<T> {
    if (record.isNew()) await this.followId(p, record.id);
    await this.save(p, record, true, opts.tokenKey);
    return this.output(record.collection, valuesOf(record));
  }

  // A request hook may change the id of a new record: its uploads move to the new storage dir.
  private async followId(p: PreparedWrite, id: string): Promise<void> {
    const { ctx } = p;
    if (id === ctx.recordId || !storableId(id)) return;
    const from = `${ctx.collection.id}/${ctx.recordId}/`;
    const written: string[] = [];
    for (const key of ctx.written) {
      const blob = await ctx.files.file(key);
      const to = fileKey(ctx.collection.id, id, key.slice(from.length));
      if (blob) {
        await ctx.files.write(to, blob);
        written.push(to);
      }
      await this.quietly(ctx.files.delete(key));
    }
    ctx.recordId = id;
    ctx.written = written;
  }

  async deletePrepared(_p: PreparedWrite, id: string): Promise<void> {
    const c = this.writable();
    await this.deleteRecord(new RecordModel(c, this.load(c, id), false));
  }

  // PB TruncateCollection: every record goes through the hooked delete, in one transaction
  async truncate(): Promise<void> {
    this.writable();
    await this.deps.db.write(() => this.deleteWhere("1 = 1", []));
  }

  // Deletes the matching records one by one through the hooked delete. Call it inside a write.
  async deleteWhere(where: string, params: unknown[]): Promise<void> {
    const c = this.collection();
    const { db } = this.deps;
    const ids = db.query<{ id: string }>(
      `SELECT id FROM ${quote(c.name)} WHERE ${where}`,
      params,
    );
    for (const { id } of ids) {
      const raw = db.get<Values>(
        `SELECT * FROM ${quote(c.name)} WHERE id = ?`,
        [id],
      );
      if (raw)
        await this.deleteRecord(new RecordModel(c, decode(c, raw), false));
    }
  }

  // The hooked save (PB app.Save): the hook chain runs where it is called, only the SQL takes a
  // brief write.
  private async save(
    p: PreparedWrite,
    record: RecordModel,
    validate: boolean,
    tokenKey?: string,
  ): Promise<void> {
    preparing.set(record, p);
    await saveModel(this.app, record, record.isNew(), validate, () =>
      this.execute(p, record, tokenKey),
    );
  }

  // `p.saved` is set once this write commits, so files are settled by the row's fate and not by
  // later hook errors (PB finalizes files before the user after-success handlers)
  private async execute(
    p: PreparedWrite,
    record: RecordModel,
    tokenKey?: string,
  ): Promise<void> {
    const c = record.collection;
    const { db } = this.deps;
    const original = record.isNew() ? null : valuesOf(record.original());
    await db.write(() => {
      const values = valuesOf(record);
      if (record.isNew()) {
        db.run(
          insertSql(
            c,
            c.fields.map((f) => f.name),
          ),
          dbValues(c, values),
        );
      } else {
        if (
          tokenKey !== undefined &&
          this.load(c, record.id).tokenKey !== tokenKey
        )
          throw new StaleTokenError();
        this.updateRow(c, values);
      }
      db.onComplete((err) => {
        if (err === null) p.saved = { saved: values, original };
      });
    });
    record.markAsNotNew();
  }

  deleteRecord(record: RecordModel): Promise<void> {
    const c = record.collection;
    const { db } = this.deps;
    return deleteModel(this.app, record, () =>
      db.write(() => {
        db.run(`DELETE FROM ${quote(c.name)} WHERE id = ?`, [record.id]);
        db.onComplete((err) =>
          err === null ? this.deleteDirs([`${c.id}/${record.id}`]) : undefined,
        );
      }),
    );
  }

  // values a hook set that still need preparing (a plain password, a File)
  private async latePrepare(record: RecordModel): Promise<void> {
    const p = preparing.get(record);
    if (!p) return;
    for (const f of record.collection.fields) {
      const value = record.get(f.name);
      if (needsPrepare(f, value))
        record.setRaw(f.name, await fields[f.type].prepare!(value, f, p.ctx));
    }
  }

  // PB TextField interceptor on create
  autogenerateHook(e: RecordEvent): Promise<void> {
    const values = valuesOf(e.record);
    autogenerate(e.record.collection, values);
    setValues(e.record, values);
    return e.next();
  }

  // PB onRecordValidate (priority 99)
  async validateHook(e: RecordEvent): Promise<void> {
    const { record } = e;
    const c = record.collection;
    await this.latePrepare(record);
    const values = valuesOf(record);
    if (record.isNew()) autogenerate(c, values);
    this.check(
      c,
      values,
      record.isNew() ? null : valuesOf(record.original()),
      record.isNew() ? CREATE_FAILED : UPDATE_FAILED,
    );
    setValues(record, values);
    await e.next();
  }

  // PB onRecordSaveExecute (priority 99) with the autodate interceptor
  async saveExecuteHook(e: RecordEvent): Promise<void> {
    const { record } = e;
    const c = record.collection;
    const message = record.isNew() ? CREATE_FAILED : UPDATE_FAILED;
    await this.latePrepare(record);
    const values = valuesOf(record);
    this.stamp(c, values, record.isNew() ? "onCreate" : "onUpdate");
    if (c.type === "auth") {
      if (!record.isNew())
        this.refreshTokenKey(c, values, valuesOf(record.original()));
      this.checkAuthId(c, values, message);
    }
    setValues(record, values);
    try {
      await e.next();
    } catch (err) {
      throw this.uniqueError(c, err, message);
    }
  }

  // PB onRecordDeleteExecute (priority 99): the delete and its relation cascade in one transaction
  async deleteExecuteHook(e: RecordEvent): Promise<void> {
    const refs = this.references(e.record.collection);
    await e.app.db.write(async () => {
      await e.next();
      for (const { other, f } of refs)
        for (const id of this.referencing(other, f, e.record))
          await this.unlink(other, f, id, e.record.id);
    });
  }

  query(opts: QueryOpts): ListResult<T> {
    const c = this.collection();
    const { db, store, now } = this.deps;
    const request = opts.request ?? null;
    const isSuperuser = !request || request.authCollection === "_superusers";

    const compiler = new QueryCompiler({ collection: c, store, request, now });
    compiler.allowHidden = true;
    compiler.filter(opts.ruleFilter ?? null);
    compiler.allowHidden = isSuperuser;
    compiler.filter(opts.filter ?? null);
    compiler.sort(parseSort(opts.sort ?? ""));
    const built = compiler.build();

    const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
    const perPage = Math.min(
      opts.perPage && opts.perPage > 0
        ? Math.floor(opts.perPage)
        : DEFAULT_PER_PAGE,
      MAX_PER_PAGE,
    );
    const table = quote(c.name);
    const from = `FROM ${table} ${built.joins.join(" ")} WHERE ${built.sql}`;

    const n = built.params.length;
    const rows = db.query<Values>(
      `SELECT DISTINCT ${table}.* ${from}${built.orderBy ? ` ORDER BY ${built.orderBy}` : ""} LIMIT ?${n + 1} OFFSET ?${n + 2}`,
      [...built.params, perPage, perPage * (page - 1)],
    );

    let totalItems = -1;
    let totalPages = -1;
    if (!opts.skipTotal) {
      const countCol = c.type === "view" ? "id" : "_rowid_";
      totalItems = db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT ${table}.${countCol}) AS n ${from}`,
        built.params,
      )!.n;
      totalPages = Math.ceil(totalItems / perPage);
    }

    if (opts.raw) {
      const items = rows.map((row) => decode(c, row));
      return { page, perPage, totalItems, totalPages, items: items as T[] };
    }
    const managed = managedIds(
      this.deps,
      c,
      rows.map((r) => r.id as string),
      request,
      opts.manageRule,
    );
    const items = rows.map((row) => {
      const values = decode(c, row);
      return serializeRecord(c, values, {
        isSuperuser,
        isOwner:
          (request?.auth?.id === values.id && c.type === "auth") ||
          managed.has(values.id as string),
      });
    });
    return { page, perPage, totalItems, totalPages, items: items as T[] };
  }

  findRaw(id: string): Values {
    return this.load(this.collection(), id);
  }

  private collection(): Collection {
    const c = this.deps.store.find(this.name);
    if (!c) throw new NotFoundError();
    return c;
  }

  private writable(): Collection {
    const c = this.collection();
    if (c.type === "view")
      throw new ValidationError("View collections are read-only.");
    return c;
  }

  private load(c: Collection, id: string): Values {
    const raw = this.deps.db.get<Values>(
      `SELECT * FROM ${quote(c.name)} WHERE id = ?`,
      [id],
    );
    if (!raw) throw new NotFoundError();
    return decode(c, raw);
  }

  private output(c: Collection, values: Values): T {
    return serializeRecord(c, values, {
      isSuperuser: true,
      isOwner: true,
    }) as T;
  }

  private updateRow(c: Collection, values: Values): void {
    const cols = c.fields.filter((f) => f.name !== "id");
    this.deps.db.run(
      `UPDATE ${quote(c.name)} SET ${cols.map((f) => `${quote(f.name)} = ?`).join(", ")} WHERE id = ?`,
      [...dbValues({ ...c, fields: cols }, values), values.id],
    );
  }

  private prepareCtx(collection: Collection, recordId: string): PrepareCtx {
    return {
      collection,
      recordId,
      files: storableId(recordId) ? this.deps.files : DISCARD,
      written: [],
    };
  }

  private newId(c: Collection, data: Values): string {
    const id = toStr(draftValues(c, null, data).id);
    const pattern = c.fields.find((f) => f.name === "id")?.autogeneratePattern;
    return id === "" && typeof pattern === "string" && pattern !== ""
      ? randomByPattern(pattern)
      : id;
  }

  // the submitted values with the uploads and hashes `prepare` made for them
  private resolve(p: PreparedWrite, data: Values): Values {
    const out = { ...data };
    for (const key of Object.keys(data)) {
      const f = p.ctx.collection.fields.find((f) => modifier(f, key));
      const pairs = f && p.resolved.get(f.name);
      if (pairs && modifier(f, key) !== "subtract")
        out[key] = swap(pairs, data[key]);
    }
    return out;
  }

  async commit<R>(p: PreparedWrite, write: () => Promise<R>): Promise<R> {
    // inside an outer write the files are settled once it commits or rolls back
    let settled: Promise<void> | undefined;
    try {
      return await write();
    } finally {
      this.deps.db.onComplete(() => (settled = this.settle(p)));
      await settled;
    }
  }

  // Call it after the outermost write ended. Files written while preparing are deleted unless the
  // record write committed. After the commit, uploads the record does not keep and files the
  // update dropped (with their thumbs) are deleted.
  async settle(p: PreparedWrite): Promise<void> {
    const { collection, recordId, files, written } = p.ctx;
    const { saved, original } = p.saved ?? {
      saved: {},
      original: null,
    };
    const { id } = collection;
    const kept = new Set<string>();
    const dropped: string[] = [];
    for (const f of collection.fields) {
      if (f.type !== "file") continue;
      const names = uniqueStrings(saved[f.name]);
      for (const name of names) kept.add(fileKey(id, recordId, name));
      for (const name of uniqueStrings(original?.[f.name]))
        if (!names.includes(name)) dropped.push(name);
    }
    for (const key of written)
      if (!kept.has(key)) await this.quietly(files.delete(key));
    for (const name of dropped) {
      await this.quietly(files.delete(fileKey(id, recordId, name)));
      await this.quietly(
        files.deletePrefix(fileKey(id, recordId, `thumbs_${name}`)),
      );
    }
  }

  private async deleteDirs(dirs: string[]): Promise<void> {
    for (const dir of dirs)
      await this.quietly(this.deps.files.deletePrefix(dir));
  }

  // storage cleanup is best effort, like PB which only logs these failures
  private async quietly(op: Promise<void>): Promise<void> {
    try {
      await op;
    } catch (e) {
      console.warn("heybe: storage cleanup failed:", e);
    }
  }

  private check(
    c: Collection,
    values: Values,
    original: Values | null,
    message: string,
  ): void {
    const { db, store, now } = this.deps;
    const ctx: FieldCtx = {
      db,
      collection: c,
      record: values,
      original: original ?? undefined,
      isNew: original === null,
      now,
      findCollection: (idOrName) => store.find(idOrName),
    };
    const errors: Errors = {};
    for (const f of c.fields) {
      const error = fields[f.type].validate(values[f.name], f, ctx);
      if (error) errors[f.name] = error;
    }
    if (Object.keys(errors).length > 0)
      throw new ValidationError(message, errors);
    // only names and hashes outlive validation: no uploads, no plain passwords
    for (const f of c.fields) {
      const v = values[f.name];
      if (f.type === "file")
        values[f.name] = fields.file.fromDb(fields.file.toDb(v), f);
      if (v instanceof PasswordValue)
        values[f.name] = new PasswordValue(v.hash);
    }
  }

  private stamp(
    c: Collection,
    values: Values,
    when: "onCreate" | "onUpdate",
  ): void {
    for (const f of c.fields) {
      if (f.type === "autodate" && f[when] === true)
        values[f.name] = formatDate(this.deps.now());
    }
  }

  private checkAuthId(c: Collection, values: Values, message: string): void {
    if (c.type !== "auth") return;
    for (const other of this.deps.store.all()) {
      if (other.type !== "auth" || other.id === c.id) continue;
      if (
        this.deps.db.get(`SELECT 1 FROM ${quote(other.name)} WHERE id = ?`, [
          values.id,
        ])
      )
        throw new ValidationError(message, {
          id: {
            code: "validation_invalid_auth_id",
            message: "Invalid or duplicated auth record id.",
          },
        });
    }
  }

  private refreshTokenKey(
    c: Collection,
    values: Values,
    original: Values,
  ): void {
    const hash = (v: Values) => (v.password as { hash: string }).hash;
    const tokenKey = c.fields.find((f) => f.name === "tokenKey");
    const pattern = tokenKey?.autogeneratePattern;
    if (
      typeof pattern === "string" &&
      pattern !== "" &&
      values.tokenKey === original.tokenKey &&
      (hash(values) !== hash(original) || values.email !== original.email)
    )
      values.tokenKey = randomByPattern(pattern);
  }

  // PB NormalizeUniqueIndexError
  private uniqueError(c: Collection, e: unknown, message: string): unknown {
    const text = e instanceof Error ? e.message.toLowerCase() : "";
    if (!text.includes("unique constraint failed")) return e;
    const failed = text.replaceAll(",", " ") + " ";
    const errors: Errors = {};
    for (const f of c.fields) {
      if (failed.includes(` ${c.name.toLowerCase()}.${f.name.toLowerCase()} `))
        errors[f.name] = {
          code: "validation_not_unique",
          message: "Value must be unique.",
        };
    }
    if (Object.keys(errors).length === 0) return e;
    return new ValidationError(message, errors);
  }

  private references(c: Collection): { other: Collection; f: Field }[] {
    return this.deps.store
      .all()
      .filter((other) => other.type !== "view")
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((other) =>
        other.fields
          .filter((f) => f.type === "relation" && f.collectionId === c.id)
          .map((f) => ({ other, f })),
      );
  }

  private referencing(other: Collection, f: Field, record: RecordModel) {
    const col = `${quote(other.name)}.${quote(f.name)}`;
    const match =
      Number(f.maxSelect) > 1
        ? `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE json_array(${col}) END) WHERE value = ?1)`
        : `${col} = ?1`;
    const self =
      other.id === record.collection.id
        ? ` AND ${quote(other.name)}.id != ?1`
        : "";
    return this.deps.db
      .query<{ id: string }>(
        `SELECT ${quote(other.name)}.id FROM ${quote(other.name)} WHERE ${match}${self}`,
        [record.id],
      )
      .map((r) => r.id);
  }

  // PB deleteRefRecords: deletes the reference (cascadeDelete) or saves it without the id, unvalidated
  private async unlink(
    other: Collection,
    f: Field,
    id: string,
    removedId: string,
  ): Promise<void> {
    const row = this.deps.db.get<Values>(
      `SELECT * FROM ${quote(other.name)} WHERE id = ?`,
      [id],
    );
    if (!row) return;
    const ref = new RecordModel(other, decode(other, row), false);
    const ids = uniqueStrings(ref.get(f.name)).filter((v) => v !== removedId);
    const service = new RecordServiceImpl(this.app, other.name);

    if (f.cascadeDelete === true && ids.length === 0)
      return service.deleteRecord(ref);
    if (f.required === true && ids.length === 0)
      throw new ValidationError(
        `the record cannot be deleted because it is part of a required reference in record ${id} (${other.name} collection)`,
      );

    ref.set(f.name, ids);
    const p: PreparedWrite = {
      ctx: service.prepareCtx(other, id),
      resolved: new Map(),
    };
    await service.commit(p, () => service.save(p, ref, false));
  }
}
