import type { App } from "../app";
import type { Db } from "../db";
import { deleteModel, saveModel } from "../hooks/system";
import type { Filesystem } from "../files/storage";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { filterSyntaxError } from "../filter/fexpr";
import { FilterError, parseFilter } from "../filter/parse";
import { ValidationError, formatDate, randomSecret } from "../util";
import {
  AUTH_KEYS,
  AUTH_SHAPE,
  type RuleCheck,
  validateAuthOptions,
} from "./auth-options";
import {
  IndexErrors,
  buildIndex,
  dropTable,
  findSingleColumnUniqueIndex,
  parseIndex,
  quote,
  syncTable,
} from "./ddl";
import {
  type Errors,
  type FieldErr,
  type Rule,
  addError,
  err,
  invalidFormat,
  rawErrors,
  required,
} from "./errors";
import { decodeCollection } from "./codec";
import type { CollectionsQuery } from "./search";
import {
  addFields,
  validateFieldSettings,
  withDefaults,
  zero,
} from "./field-settings";
import {
  type Collection,
  type CollectionType,
  type Field,
  collectionId,
} from "./model";
import {
  authSystemFields,
  bootstrapCollections,
  idField,
  scaffold,
} from "./scaffold";
import {
  createViewFields,
  deleteView,
  dryRunView,
  inferViewFields,
  normalizeViewQueryId,
  saveView,
} from "./view";

interface Row {
  id: string;
  name: string;
  type: Collection["type"];
  system: number;
  data: string;
  created: string;
  updated: string;
}

const EMPTY_REQUEST: RequestInfo = {
  auth: null,
  authCollection: null,
  body: {},
  query: {},
  headers: {},
  method: "",
  context: "",
};

const NAME_PATTERN = /^\w+$/;
const ID_PATTERN = /^[^@#$&|.,'"\\/\s]+$/;
const RESERVED_AUTH_NAMES = ["passwordConfirm", "oldPassword"];
const RULES = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
] as const;

const hasVia: Rule = [
  "validation_found_via",
  'The value cannot contain "_via_".',
];

function toRow(c: Collection): Row {
  const { id, name, type, system, created, updated, ...rest } = c;
  if (type !== "auth") for (const key of AUTH_KEYS) delete rest[key];
  if (type !== "view") delete rest.viewQuery;
  return {
    id,
    name,
    type,
    system: system ? 1 : 0,
    data: JSON.stringify(rest),
    created,
    updated,
  };
}

function fromRow(row: Row): Collection {
  return {
    ...JSON.parse(row.data),
    id: row.id,
    name: row.name,
    type: row.type,
    system: row.system === 1,
    created: row.created,
    updated: row.updated,
  };
}

const SYSTEM_RULE_CHANGE: Rule = [
  "validation_collection_system_rule_change",
  "System collection API rule cannot be changed.",
];

function ensureSystemFields(c: Collection) {
  if (c.type === "view") return;
  const fields = [...c.fields];
  const at = (name: string) => fields.findIndex((f) => f.name === name);

  const idAt = fields.findIndex((f) => f.name === "id" && f.type === "text");
  if (idAt < 0) fields.unshift(idField());
  else {
    const pattern = fields[idAt]!.pattern || idField().pattern;
    fields[idAt] = {
      ...fields[idAt]!,
      system: true,
      required: true,
      primaryKey: true,
      hidden: false,
      pattern,
    };
  }

  if (c.type === "auth") {
    for (const sys of authSystemFields()) {
      const i = at(sys.name);
      if (i < 0) fields.push(sys);
      else if (fields[i]!.type !== sys.type)
        fields[i] = { ...sys, id: fields[i]!.id };
      else {
        const enforce =
          sys.name === "password" || sys.name === "tokenKey"
            ? { hidden: true, required: true }
            : {};
        fields[i] = {
          ...fields[i]!,
          system: true,
          ...enforce,
          ...(sys.name === "email" ? { hidden: false } : {}),
        };
      }
    }
    const indexes = [...c.indexes];
    const suffix = (name: string) => `idx_${name}_${c.id}`.slice(0, 64);
    if (!findSingleColumnUniqueIndex(indexes, "tokenKey")) {
      indexes.push(
        `CREATE UNIQUE INDEX ${quote(suffix("tokenKey"))} ON ${quote(c.name)} (${quote("tokenKey")})`,
      );
    }
    if (!findSingleColumnUniqueIndex(indexes, "email")) {
      indexes.push(
        `CREATE UNIQUE INDEX ${quote(suffix("email"))} ON ${quote(c.name)} (${quote("email")}) WHERE ${quote("email")} != ''`,
      );
    }
    c.indexes = indexes;
  }
  c.fields = fields;
}

function rowInsert(c: Collection): [string, unknown[]] {
  const row = toRow(c);
  return [
    "INSERT OR REPLACE INTO _collections (id, name, type, system, data, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.name,
      row.type,
      row.system,
      row.data,
      row.created,
      row.updated,
    ],
  ];
}

export interface SaveInput extends Partial<Collection> {
  name: string;
}

type Prepared = { old: Collection | null; next: Collection };

export class CollectionStore {
  onChange?: () => void;
  // set by createApp: saves and deletes then run the model and collection hooks
  app?: App;
  // ids of the collections being created, and of those deleted without integrity checks
  private readonly creating = new Set<string>();
  private readonly unchecked = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly files?: Filesystem,
  ) {
    db.tx(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS _collections (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL, system INTEGER NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)",
      );
      db.run(
        "CREATE INDEX IF NOT EXISTS idx__collections_type ON _collections (type)",
      );
      db.run(
        "CREATE TABLE IF NOT EXISTS _params (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      if (!this.find("_superusers"))
        for (const c of bootstrapCollections()) {
          const { old, next } = this.prepare(c);
          this.validate(old, next);
          this.enforceSuperusers(next);
          this.syncTable(old, next);
          db.run(...rowInsert(next));
        }
    });
  }

  all(): Collection[] {
    return this.db
      .query<Row>("SELECT * FROM _collections ORDER BY rowid")
      .map(fromRow);
  }

  search(q: CollectionsQuery, limit: number, offset: number): Collection[] {
    return this.db
      .query<Row>(
        `SELECT * FROM _collections WHERE ${q.where}${q.orderBy ? ` ORDER BY ${q.orderBy}` : ""} LIMIT ?${q.params.length + 1} OFFSET ?${q.params.length + 2}`,
        [...q.params, limit, offset],
      )
      .map(fromRow);
  }

  count(q: CollectionsQuery): number {
    return this.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM _collections WHERE ${q.where}`,
      q.params,
    )!.n;
  }

  find(nameOrId: string): Collection | null {
    const row = this.db.get<Row>(
      "SELECT * FROM _collections WHERE id = ?1 OR name = ?1 COLLATE NOCASE",
      [nameOrId],
    );
    return row ? fromRow(row) : null;
  }

  async save(input: SaveInput, isNew = false): Promise<Collection> {
    const { old, next } = this.prepare(input, isNew);
    await this.saveHooked(next, old === null, true);
    return next;
  }

  // PB app.Save / app.SaveNoValidate
  private async saveHooked(c: Collection, isNew: boolean, validate: boolean) {
    if (isNew) this.creating.add(c.id);
    const write = () => this.persistRow(c);
    try {
      if (this.app) await saveModel(this.app, c, isNew, validate, write);
      else {
        if (validate) this.validateSave(c);
        await this.executeSave(c, write);
      }
    } finally {
      this.creating.delete(c.id);
    }
  }

  // the stored version of a collection being saved
  private stored(c: Collection): Collection | null {
    return this.creating.has(c.id) ? null : this.find(c.id);
  }

  // PB onCollectionValidate
  validateSave(c: Collection): void {
    this.validate(this.stored(c), c);
  }

  // PB onCollectionSaveExecute: the view or table sync around `write` in one transaction, then the
  // dependent views
  async executeSave(c: Collection, write: () => Promise<void>): Promise<void> {
    await this.db.write(async () => {
      const old = this.stored(c);
      this.changed();
      this.enforceSuperusers(c);
      if (c.type === "view") this.persistView(old, c);
      await write();
      this.syncTable(old, c);
    });
    await this.resaveViewsLogged([c.id], c.name);
  }

  // after the commit: onChange, then the storage dirs of deleted collections
  private changed(removed: string[] = []) {
    this.db.onComplete((err) => {
      if (err !== null) return;
      this.onChange?.();
      return this.deleteFiles(removed);
    });
  }

  // PB only logs these, so the user can fix the view queries afterwards
  private async resaveViewsLogged(excludeIds: string[], name: string) {
    try {
      await this.resaveViews(excludeIds);
    } catch (e) {
      console.warn(
        `heybe: dependent view collection(s) may need to be updated after ${name} collection change:`,
        e,
      );
    }
  }

  // Port of PB resaveViewsWithChangedFields: changed views are saved through the hooks, in one
  // transaction that rolls back when any of them fails.
  private resaveViews(excludeIds: string[]): Promise<void> {
    const comparable = (fields: Field[]) =>
      JSON.stringify(
        fields.map((f) =>
          Object.fromEntries(
            Object.entries({ ...f, id: "" }).sort(([a], [b]) =>
              a < b ? -1 : 1,
            ),
          ),
        ),
      ).toLowerCase();
    return this.db.write(async () => {
      const failures: string[] = [];
      for (const view of this.all()) {
        if (view.type !== "view" || excludeIds.includes(view.id)) continue;
        try {
          const fields = inferViewFields(this.db, this, String(view.viewQuery));
          if (comparable(fields) !== comparable(view.fields))
            await this.save(view);
        } catch (e) {
          failures.push(`[${view.name}] ${(e as Error).message}`);
        }
      }
      if (failures.length > 0) throw new Error(failures.join("\n"));
    });
  }

  // PB ImportCollections: in one transaction the missing collections are deleted and the imported
  // ones saved through the hooks (integrity checks and validation off), then all are validated.
  async import(
    items: Record<string, unknown>[],
    deleteMissing: boolean,
  ): Promise<void> {
    if (items.length === 0) throw new Error("no collections to import");
    await this.db.write(async () => {
      const inputs = items.map((data) => this.importInput(data, deleteMissing));
      const prepared = inputs.map((input) => this.prepare(input));
      const originals = new Map(
        this.all().map((c) => [c.id, c] as [string, Collection]),
      );

      if (deleteMissing) {
        const keep = new Set(prepared.map((p) => p.next.id));
        for (const existing of this.all())
          if (!keep.has(existing.id) && !existing.system)
            await this.deleteHooked(existing, false);
      }

      const ordered = [...prepared].sort(
        (a, b) =>
          Number(a.next.type === "view") - Number(b.next.type === "view"),
      );
      for (const { old, next } of ordered)
        await this.saveHooked(next, old === null, false);

      for (const { next } of ordered) {
        const original = originals.get(next.id) ?? next;
        try {
          this.validate(original, next);
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e;
          throw new ValidationError("Failed to import collections.", {
            collections: err([
              "validation_collections_import_failure",
              `Data validations failed for collection "${next.name}" (${next.id}):\n${JSON.stringify(rawErrors(e.data), null, 2)}`,
            ]),
          });
        }
      }
    });
  }

  async delete(nameOrId: string): Promise<void> {
    await this.deleteHooked(this.require(nameOrId), true);
  }

  // PB app.Delete; `checks` false is PB IntegrityChecks(false)
  private async deleteHooked(c: Collection, checks: boolean) {
    if (!checks) this.unchecked.add(c.id);
    const write = () =>
      this.db.write(() => {
        this.db.run("DELETE FROM _collections WHERE id = ?", [c.id]);
      });
    try {
      if (this.app) await deleteModel(this.app, c, write);
      else await this.executeDelete(c, write);
    } finally {
      this.unchecked.delete(c.id);
    }
  }

  // PB onCollectionDeleteExecute. The storage dir goes after the outermost commit.
  async executeDelete(
    c: Collection,
    write: () => Promise<void>,
  ): Promise<void> {
    if (c.system)
      throw new Error(`[${c.name}] system collections cannot be deleted`);
    const checks = !this.unchecked.has(c.id);
    const refs = checks ? this.references(c) : [];
    if (refs.length > 0)
      throw new Error(
        `[${c.name}] failed to delete due to existing relation references: ${refs.map((r) => r.name).join(", ")}`,
      );
    await this.db.write(async () => {
      this.changed([c.id]);
      dropTable(this.db, c);
      if (checks)
        try {
          await this.resaveViews([c.id]);
        } catch (e) {
          throw new Error(
            `[${c.name}] failed to delete due to existing view dependency: ${(e as Error).message}`,
          );
        }
      await write();
    });
  }

  // like PB the storage dir goes after the commit, and a failure is only logged
  private async deleteFiles(collectionIds: string[]): Promise<void> {
    for (const id of collectionIds) {
      try {
        await this.files?.deletePrefix(id);
      } catch (e) {
        console.warn("heybe: storage cleanup failed:", e);
      }
    }
  }

  references(c: Collection): Collection[] {
    return this.all().filter(
      (other) =>
        other.id !== c.id &&
        other.fields.some(
          (f) => f.type === "relation" && f.collectionId === c.id,
        ),
    );
  }

  private importInput(
    data: Record<string, unknown>,
    deleteMissing: boolean,
  ): SaveInput {
    const identifier = String(data.id || data.name || "");
    const existing = identifier ? this.find(identifier) : null;
    if (!existing) {
      const blank = scaffold(
        typeof data.type === "string" ? (data.type as CollectionType) : "base",
        typeof data.name === "string" ? data.name : "",
        typeof data.id === "string" ? data.id : undefined,
      );
      const decoded = decodeCollection(blank, data);
      if (typeof data.id !== "string" || data.id === "")
        delete (decoded as Partial<Collection>).id;
      return decoded;
    }

    const body =
      data.fields == null && deleteMissing ? { ...data, fields: [] } : data;
    const decoded = decodeCollection(existing, body);
    for (const f of existing.fields) {
      if (!f.system && deleteMissing) continue;
      if (decoded.fields.some((m) => m.id === f.id)) continue;
      const found = decoded.fields.find((m) => m.name === f.name);
      if (found && found.type === f.type) found.id = f.id;
      decoded.fields = addFields(decoded.fields, [f]);
    }
    return decoded;
  }

  private prepare(input: SaveInput, isNew = false): Prepared {
    const old = input.id && !isNew ? this.find(input.id) : null;
    const defined = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    );
    const timestamp = formatDate(this.now());

    let next: Collection;
    if (old) {
      next = {
        ...old,
        ...defined,
        created: old.created,
        updated: timestamp,
      } as Collection;
    } else {
      const type = input.type ?? "base";
      next = {
        ...scaffold(
          type,
          input.name,
          input.id ?? this.freeId(type, input.name),
        ),
        ...defined,
      } as Collection;
      next.created = next.updated = timestamp;
    }

    next.fields = withDefaults(
      (input.fields ?? next.fields) as Partial<Field>[],
    );
    next.indexes = next.indexes ?? [];
    ensureSystemFields(next);
    next.indexes = next.indexes.map((sql) => {
      const parsed = parseIndex(sql);
      if (!parsed || parsed.table === next.name) return sql;
      return buildIndex({ ...parsed, table: next.name });
    });
    if (next.type === "auth") {
      next = { ...zero(AUTH_SHAPE), ...next };
      if (old && String(old.authRule ?? "") !== String(next.authRule ?? ""))
        (next.authToken as { secret: string }).secret = randomSecret(50);
      this.unsetMissingMappedFields(next);
    }
    return { old, next };
  }

  private unsetMissingMappedFields(c: Collection) {
    const mapped = (c.oauth2 as { mappedFields: Record<string, string> })
      .mappedFields;
    for (const [key, name] of Object.entries(mapped)) {
      if (name !== "" && !c.fields.some((f) => f.name === name))
        mapped[key] = "";
    }
  }

  // PB forces these on the superusers collection after validation, so it can't be locked out or sign in with OAuth2.
  private enforceSuperusers(c: Collection) {
    if (c.name !== "_superusers") return;
    const { oauth2, passwordAuth, otp, mfa } = c as unknown as Record<
      string,
      Record<string, unknown>
    >;
    oauth2!.enabled = false;
    oauth2!.providers = [];
    passwordAuth!.enabled = true;
    if (otp!.enabled === true) mfa!.enabled = true;
  }

  private async persistRow(c: Collection): Promise<void> {
    await this.db.write(() => {
      this.db.run(...rowInsert(c));
    });
  }

  private syncTable(old: Collection | null, next: Collection) {
    try {
      syncTable(this.db, old, next);
    } catch (e) {
      if (!(e instanceof IndexErrors)) throw e;
      throw new ValidationError(
        `Failed to ${old ? "update" : "create"} collection.`,
        { indexes: e.errors },
      );
    }
  }

  private persistView(old: Collection | null, next: Collection) {
    const query = String(next.viewQuery ?? "");
    const fields = inferViewFields(this.db, this, query);
    if (old) deleteView(this.db, old.name);
    saveView(this.db, next.name, normalizeViewQueryId(this.db, query));
    next.fields = fields;
  }

  require(nameOrId: string): Collection {
    const c = this.find(nameOrId);
    if (!c) throw new ValidationError("Collection not found.");
    return c;
  }

  private freeId(type: string, name: string): string {
    const root = collectionId(type, name);
    let id = root;
    for (
      let i = 2;
      this.db.get("SELECT 1 FROM _collections WHERE id = ?", [id]);
      i++
    )
      id = root + i;
    return id;
  }

  private validate(old: Collection | null, next: Collection) {
    const errors: Errors = {};
    const isNew = !old;
    const fail = (key: string, rule: Rule) => addError(errors, [key], rule);

    if (isNew) {
      if (next.id.length > 100 || !ID_PATTERN.test(next.id))
        fail("id", invalidFormat);
      else if (
        this.db.get("SELECT 1 FROM _collections WHERE id = ?", [next.id])
      )
        fail("id", [
          "validation_invalid_or_existing_id",
          "The model id is invalid or already exists.",
        ]);
    }
    if (old && next.system !== old.system) {
      fail("system", [
        "validation_collection_system_flag_change",
        "System collection state cannot be changed.",
      ]);
    }
    if (!["base", "auth", "view"].includes(next.type)) {
      fail("type", ["validation_in_invalid", "Must be a valid value."]);
    } else if (old && next.type !== old.type) {
      fail("type", [
        "validation_collection_type_change",
        "Collection type cannot be changed.",
      ]);
    }

    // view fields are always generated from the query, overwriting any submitted ones
    if (next.type === "view")
      next.fields = createViewFields(
        this.db,
        this,
        String(next.viewQuery ?? ""),
      ).fields;

    this.validateName(errors, old, next);
    this.validateFields(errors, old, next);
    if (next.type === "view") this.validateViewQuery(errors, next);

    const ruleCheck: RuleCheck = (value, oldValue) =>
      this.checkRule(next, value) ??
      (old?.system && (value ?? null) !== (oldValue ?? null)
        ? err(SYSTEM_RULE_CHANGE)
        : null);

    for (const key of RULES) {
      if (
        next.type === "view" &&
        key !== "listRule" &&
        key !== "viewRule" &&
        next[key] !== null
      ) {
        fail(key, ["validation_nil", "Must be blank."]);
        continue;
      }
      const e = ruleCheck(next[key], old?.[key]);
      if (e) errors[key] = e;
    }
    if (next.type === "auth")
      Object.assign(errors, validateAuthOptions(next, old, ruleCheck));

    this.validateIndexes(errors, old, next);

    if (Object.keys(errors).length > 0) {
      throw new ValidationError(
        `Failed to ${isNew ? "create" : "update"} collection.`,
        errors,
      );
    }
  }

  private validateViewQuery(errors: Errors, next: Collection) {
    const query = String(next.viewQuery ?? "");
    if (query === "") return addError(errors, ["viewQuery"], required);
    try {
      dryRunView(this.db, this, query, 10);
    } catch (e) {
      addError(
        errors,
        ["viewQuery"],
        [
          "validation_invalid_view_query",
          `Invalid query - ${(e as Error).message.slice(0, 500)}`,
        ],
      );
    }
  }

  private checkRule(c: Collection, rule: unknown): FieldErr | null {
    if (typeof rule !== "string" || rule === "") return null;
    let message = filterSyntaxError(rule);
    if (message === null) {
      try {
        const compiler = new QueryCompiler({
          collection: c,
          store: this,
          request: EMPTY_REQUEST,
          now: this.now,
        });
        compiler.allowHidden = true;
        compiler.filter(parseFilter(rule));
      } catch (e) {
        if (!(e instanceof FilterError)) throw e;
        message = e.message;
      }
    }
    if (message === null) return null;
    const sentence = /[.?!]$/.test(message) ? message : `${message}.`;
    return err([
      "validation_invalid_rule",
      `Invalid rule. Raw error: ${sentence}`,
    ]);
  }

  private validateName(
    errors: Errors,
    old: Collection | null,
    next: Collection,
  ) {
    const name = next.name;
    if (typeof name !== "string" || name === "")
      return addError(errors, ["name"], required);
    if (name.length > 255) {
      return addError(
        errors,
        ["name"],
        [
          "validation_length_out_of_range",
          "The length must be between 1 and 255.",
        ],
        { min: 1, max: 255 },
      );
    }
    if (name.toLowerCase().includes("_via_"))
      return addError(errors, ["name"], hasVia);
    if (!NAME_PATTERN.test(name))
      return addError(errors, ["name"], invalidFormat);
    if (old?.system && name !== old.name) {
      return addError(
        errors,
        ["name"],
        [
          "validation_collection_system_name_change",
          "System collection name cannot be changed.",
        ],
      );
    }
    const clash = this.db.get<{ id: string }>(
      "SELECT id FROM _collections WHERE name = ? COLLATE NOCASE AND id != ?",
      [name, old?.id ?? ""],
    );
    if (clash) {
      return addError(
        errors,
        ["name"],
        [
          "validation_collection_name_exists",
          "Collection name must be unique (case insensitive).",
        ],
      );
    }
    if (this.db.get("SELECT 1 FROM _collections WHERE id = ?", [name])) {
      return addError(
        errors,
        ["name"],
        [
          "validation_collection_name_id_duplicate",
          "The name must not match an existing collection id.",
        ],
      );
    }
    const isRename = !old || old.name !== name;
    if (
      isRename &&
      this.db.get(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1 COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM _collections WHERE name = ?1 COLLATE NOCASE)",
        [name],
      )
    ) {
      addError(
        errors,
        ["name"],
        [
          "validation_collection_name_invalid",
          "The name shouldn't match with an existing internal table.",
        ],
      );
    }
  }

  private validateFields(
    errors: Errors,
    old: Collection | null,
    next: Collection,
  ) {
    const steps: (() => unknown)[] = [
      () => this.checkDuplicates(next.fields),
      () => this.checkMinFields(next),
    ];
    if (next.type !== "view")
      steps.push(
        () => this.checkSystemFields(old, next.fields),
        () => this.checkTypeChanges(old, next.fields),
      );
    if (next.type === "auth") steps.push(() => this.checkReserved(next.fields));
    steps.push(() => this.checkSettings(old, next));

    for (const step of steps) {
      const e = step();
      if (e) {
        errors.fields = e;
        return;
      }
    }
  }

  private checkDuplicates(fields: Field[]): Errors | null {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [i, f] of fields.entries()) {
      if (ids.has(f.id)) {
        return {
          [i]: {
            id: err([
              "validation_duplicated_field_id",
              `Duplicated or invalid field id "${f.id}"`,
            ]),
          },
        };
      }
      const lower = String(f.name).toLowerCase();
      if (names.has(lower)) {
        return {
          [i]: {
            name: err(
              [
                "validation_duplicated_field_name",
                `Duplicated or invalid field name ${f.name}.`,
              ],
              { fieldName: f.name },
            ),
          },
        };
      }
      ids.add(f.id);
      names.add(lower);
    }
    return null;
  }

  private checkMinFields(next: Collection): unknown {
    const fields = next.fields;
    if (fields.length === 0) return err(required);
    const id = fields.find((f) => f.name === "id");
    if (!id || id.type !== "text" || !id.primaryKey) {
      return err([
        "validation_missing_primary_key",
        'Missing or invalid "id" PK field.',
      ]);
    }
    if (next.type !== "auth") return null;

    const systemTypes = {
      password: "password",
      tokenKey: "text",
      email: "email",
      emailVisibility: "bool",
      verified: "bool",
    };
    for (const [name, type] of Object.entries(systemTypes)) {
      const f = fields.find((x) => x.name === name);
      if (!f || f.type !== type) {
        return err([
          `validation_missing_${name}_field`,
          `System "${name}" field is required.`,
        ]);
      }
      const hidden = name === "password" || name === "tokenKey";
      if (!f.system || (hidden && !f.hidden)) {
        return {
          [name]: hidden
            ? err([
                "validation_must_be_system_and_hidden",
                'The field must be marked as "System" and "Hidden".',
              ])
            : err([
                "validation_must_be_system",
                'The field must be marked as "System".',
              ]),
        };
      }
    }
    return null;
  }

  private checkSystemFields(old: Collection | null, fields: Field[]) {
    if (!old) return null;
    for (const oldField of old.fields.filter((f) => f.system)) {
      const f = fields.find((x) => x.id === oldField.id);
      if (!f || f.name !== oldField.name) {
        return err([
          "validation_system_field_change",
          "System fields cannot be deleted or renamed.",
        ]);
      }
    }
    return null;
  }

  private checkTypeChanges(old: Collection | null, fields: Field[]) {
    if (!old) return null;
    const out: Errors = {};
    for (const [i, f] of fields.entries()) {
      const oldField = old.fields.find((x) => x.id === f.id);
      if (oldField && oldField.type !== f.type)
        out[i] = err([
          "validation_field_type_change",
          "Field type cannot be changed.",
        ]);
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private checkReserved(fields: Field[]) {
    const out: Errors = {};
    for (const [i, f] of fields.entries()) {
      if (RESERVED_AUTH_NAMES.includes(f.name)) {
        out[i] = {
          name: err([
            "validation_reserved_field_name",
            "The field name is reserved and cannot be used.",
          ]),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private checkSettings(old: Collection | null, next: Collection) {
    const out: Errors = {};
    for (const [i, f] of next.fields.entries()) {
      const e = validateFieldSettings(f, {
        collection: next,
        find: (idOrName) => this.find(idOrName),
        oldField: old?.fields.find((x) => x.id === f.id),
      });
      if (Object.keys(e).length > 0) out[i] = e;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private validateIndexes(
    errors: Errors,
    old: Collection | null,
    next: Collection,
  ) {
    const indexes = next.indexes;
    if (next.type === "view" && indexes.length > 0) {
      return addError(
        errors,
        ["indexes"],
        [
          "validation_indexes_not_supported",
          "View collections don't support indexes.",
        ],
      );
    }

    const names = new Set<string>();
    const definitions = new Set<string>();
    for (const [i, sql] of indexes.entries()) {
      const at = ["indexes", i];
      const parsed = parseIndex(sql);
      if (!parsed)
        return addError(errors, at, [
          "validation_invalid_index_expression",
          "Invalid CREATE INDEX expression.",
        ]);
      const lower = parsed.name.toLowerCase();
      if (names.has(lower))
        return addError(errors, at, [
          "validation_duplicated_index_name",
          "The index name already exists.",
        ]);
      names.add(lower);

      const used = this.db.get<{ tbl_name: string }>(
        "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND LOWER(tbl_name) != LOWER(?) AND LOWER(tbl_name) != LOWER(?) AND LOWER(name) = LOWER(?) LIMIT 1",
        [old?.name ?? "", next.name, parsed.name],
      );
      if (used) {
        return addError(errors, at, [
          "validation_existing_index_name",
          `The index name is already used in ${used.tbl_name} collection.`,
        ]);
      }

      const definition = buildIndex({
        ...parsed,
        name: "validator",
        table: "validator",
      });
      if (definitions.has(definition)) {
        return addError(errors, at, [
          "validation_duplicated_index_definition",
          "The index definition already exists.",
        ]);
      }
      definitions.add(definition);
    }

    if (next.type === "auth") {
      for (const name of ["tokenKey", "email"]) {
        if (!findSingleColumnUniqueIndex(indexes, name)) {
          return addError(
            errors,
            ["indexes"],
            [
              "validation_missing_required_unique_index",
              `Missing required unique index for field "${name}".`,
            ],
          );
        }
      }
    }
  }
}
