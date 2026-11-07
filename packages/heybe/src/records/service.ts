import {
  type Expr,
  type FindManyArgs,
  type ListResult,
  toAst,
  toSort,
} from "@heybe/query";
import { quote } from "../collections/ddl";
import type { Collection, Field } from "../collections/model";
import type { CollectionStore } from "../collections/store";
import type { Db } from "../db";
import { fields } from "../fields";
import type { FieldCtx } from "../fields";
import { toStr, uniqueStrings } from "../fields/shared";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { parseSort } from "../filter/parse";
import { NotFoundError, ValidationError, formatDate } from "../util";
import { randomByPattern } from "./pattern";
import { serializeRecord } from "./serialize";

export interface RecordService<T> {
  findMany(args?: FindManyArgs<T>): Promise<ListResult<T>>;
  findOne(id: string): Promise<T>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  truncate(): void;
  findRaw(id: string): Record<string, unknown>;
  query(opts: {
    filter?: Expr | null;
    sort?: string;
    page?: number;
    perPage?: number;
    skipTotal?: boolean;
    request?: RequestInfo | null;
    ruleFilter?: Expr | null;
    fields?: string;
  }): ListResult<T>;
}

type Values = Record<string, unknown>;
type Errors = Record<string, { code: string; message: string }>;

interface Deps {
  db: Db;
  store: CollectionStore;
  now: () => Date;
}

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;
const CREATE_FAILED = "Failed to create record.";
const UPDATE_FAILED = "Failed to update record.";
const LIST_TYPES = ["select", "relation", "file"];

function zeroValues(c: Collection): Values {
  return Object.fromEntries(
    c.fields.map((f) => [f.name, fields[f.type].normalize(undefined, f)]),
  );
}

function decode(c: Collection, raw: Values): Values {
  return Object.fromEntries(
    c.fields.map((f) => [f.name, fields[f.type].fromDb(raw[f.name], f)]),
  );
}

function modifier(
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

function applyModifier(
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
  const old = uniqueStrings(current);
  const mod = uniqueStrings(input);
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

function autogenerate(c: Collection, values: Values): void {
  for (const f of c.fields) {
    const pattern = f.type === "text" ? f.autogeneratePattern : "";
    if (typeof pattern === "string" && pattern !== "" && values[f.name] === "")
      values[f.name] = randomByPattern(pattern);
  }
}

function insertSql(c: Collection, cols: string[]): string {
  return `INSERT INTO ${quote(c.name)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
}

export class RecordServiceImpl<T> implements RecordService<T> {
  constructor(
    private readonly deps: Deps,
    private readonly name: string,
  ) {}

  async findMany(args: FindManyArgs<T> = {}): Promise<ListResult<T>> {
    return this.query({
      filter: args.where ? toAst<T>(args.where) : null,
      sort: toSort<T>(args.orderBy),
      page: args.page,
      perPage: args.perPage,
      skipTotal: args.count === false,
    });
  }

  async findOne(id: string): Promise<T> {
    const c = this.collection();
    return this.output(c, this.load(c, id));
  }

  async create(data: Partial<T>): Promise<T> {
    const prepared = await this.prepareInput(data as Values);
    const { c, saved } = this.deps.db.tx(() => {
      const c = this.writable();
      const values = zeroValues(c);
      assign(c, values, data as Values);
      autogenerate(c, values);
      this.check(c, values, null, CREATE_FAILED, prepared);
      this.stamp(c, values, "onCreate");
      if (c.name === "_superusers") values.verified = true;
      this.checkAuthId(c, values, CREATE_FAILED);
      this.write(c, values, CREATE_FAILED, () => {
        const cols = c.fields.map((f) => f.name);
        this.deps.db.run(insertSql(c, cols), this.dbValues(c, values));
      });
      return { c, saved: values };
    });
    return this.output(c, saved);
  }

  async update(id: string, data: Partial<T>): Promise<T> {
    const prepared = await this.prepareInput(data as Values);
    const { c, saved } = this.deps.db.tx(() => {
      const c = this.writable();
      const original = this.load(c, id);
      const values = { ...original };
      assign(c, values, data as Values);
      this.check(c, values, original, UPDATE_FAILED, prepared);
      this.stamp(c, values, "onUpdate");
      if (c.name === "_superusers") values.verified = true;
      if (c.type === "auth") this.refreshTokenKey(c, values, original);
      this.write(c, values, UPDATE_FAILED, () => this.updateRow(c, values));
      return { c, saved: values };
    });
    return this.output(c, saved);
  }

  async delete(id: string): Promise<void> {
    const c = this.writable();
    this.deps.db.tx(() => this.remove(c, this.load(c, id)));
  }

  truncate(): void {
    const c = this.writable();
    const { db } = this.deps;
    db.tx(() => {
      for (const { id } of db.query<{ id: string }>(
        `SELECT id FROM ${quote(c.name)}`,
      ))
        this.remove(c, this.load(c, id));
    });
  }

  query(opts: Parameters<RecordService<T>["query"]>[0]): ListResult<T> {
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

    const rows = db.query<Values>(
      `SELECT DISTINCT ${table}.* ${from}${built.orderBy ? ` ORDER BY ${built.orderBy}` : ""} LIMIT ${perPage} OFFSET ${perPage * (page - 1)}`,
      built.params,
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

    const items = rows.map((row) => {
      const values = decode(c, row);
      return serializeRecord(c, values, {
        isSuperuser,
        isOwner:
          request?.authCollection === c.name && request.auth?.id === values.id,
        fields: opts.fields,
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

  private dbValues(c: Collection, values: Values): unknown[] {
    return c.fields.map((f) => fields[f.type].toDb(values[f.name]));
  }

  private updateRow(c: Collection, values: Values): void {
    const cols = c.fields.filter((f) => f.name !== "id");
    this.deps.db.run(
      `UPDATE ${quote(c.name)} SET ${cols.map((f) => `${quote(f.name)} = ?`).join(", ")} WHERE id = ?`,
      [...this.dbValues({ ...c, fields: cols }, values), values.id],
    );
  }

  private async prepareInput(data: Values): Promise<Values> {
    const prepared: Values = {};
    const c = this.collection();
    for (const f of c.fields) {
      const prepare = fields[f.type].prepare;
      if (prepare && f.name in data)
        prepared[f.name] = await prepare(
          fields[f.type].normalize(data[f.name], f),
          f,
        );
    }
    return prepared;
  }

  private check(
    c: Collection,
    values: Values,
    original: Values | null,
    message: string,
    prepared: Values,
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
    Object.assign(values, prepared);
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

  private write(
    c: Collection,
    values: Values,
    message: string,
    run: () => void,
  ): void {
    try {
      run();
    } catch (e) {
      const text = e instanceof Error ? e.message.toLowerCase() : "";
      if (!text.includes("unique constraint failed")) throw e;
      const failed = text.replaceAll(",", " ") + " ";
      const errors: Errors = {};
      for (const f of c.fields) {
        if (
          failed.includes(` ${c.name.toLowerCase()}.${f.name.toLowerCase()} `)
        )
          errors[f.name] = {
            code: "validation_not_unique",
            message: "Value must be unique.",
          };
      }
      if (Object.keys(errors).length === 0) throw e;
      throw new ValidationError(message, errors);
    }
  }

  private remove(c: Collection, values: Values): void {
    const { db, store } = this.deps;
    db.run(`DELETE FROM ${quote(c.name)} WHERE id = ?`, [values.id]);

    const refs = store
      .all()
      .filter((other) => other.type !== "view")
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((other) =>
        other.fields
          .filter((f) => f.type === "relation" && f.collectionId === c.id)
          .map((f) => ({ other, f })),
      );

    for (const { other, f } of refs) {
      const col = `${quote(other.name)}.${quote(f.name)}`;
      const multiple = Number(f.maxSelect) > 1;
      const match = multiple
        ? `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${col}) THEN ${col} ELSE json_array(${col}) END) WHERE value = ?1)`
        : `${col} = ?1`;
      const self =
        other.id === c.id ? ` AND ${quote(other.name)}.id != ?1` : "";
      const ids = db
        .query<{ id: string }>(
          `SELECT ${quote(other.name)}.id FROM ${quote(other.name)} WHERE ${match}${self}`,
          [values.id],
        )
        .map((r) => r.id);
      for (const id of ids) this.unlink(other, f, id, String(values.id));
    }
  }

  private unlink(
    other: Collection,
    f: Field,
    id: string,
    removed: string,
  ): void {
    const row = this.deps.db.get<Values>(
      `SELECT * FROM ${quote(other.name)} WHERE id = ?`,
      [id],
    );
    if (!row) return;
    const refValues = decode(other, row);
    const ids = uniqueStrings(refValues[f.name]).filter((v) => v !== removed);

    if (f.cascadeDelete === true && ids.length === 0) {
      this.remove(other, refValues);
      return;
    }
    if (f.required === true && ids.length === 0)
      throw new Error(
        `the record cannot be deleted because it is part of a required reference in record ${id} (${other.name} collection)`,
      );

    refValues[f.name] = fields.relation.normalize(ids, f);
    this.stamp(other, refValues, "onUpdate");
    this.updateRow(other, refValues);
  }
}
