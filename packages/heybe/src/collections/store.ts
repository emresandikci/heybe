import type { Db } from "../db";
import { FilterError, parseFilter } from "../filter/parse";
import { ValidationError, formatDate } from "../util";
import {
  buildIndex,
  dropTable,
  findSingleColumnUniqueIndex,
  parseIndex,
  quote,
  syncTable,
} from "./ddl";
import { type Collection, type Field, collectionId, fieldId } from "./model";
import {
  authSystemFields,
  idField,
  scaffold,
  superusersScaffold,
} from "./scaffold";

interface Row {
  id: string;
  name: string;
  type: Collection["type"];
  system: number;
  data: string;
  created: string;
  updated: string;
}

type Path = (string | number)[];
type Errors = Record<string, unknown>;

const NAME_PATTERN = /^\w+$/;
const ID_PATTERN = /^[^@#$&|.,'"\\/\s]+$/;
const RESERVED_FIELD_NAMES = [
  "null",
  "true",
  "false",
  "_rowid_",
  "collectionId",
  "collectionName",
  "expand",
];
const RESERVED_AUTH_NAMES = ["passwordConfirm", "oldPassword"];
const RULES = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
] as const;
const AUTH_RULES = ["authRule", "manageRule"] as const;

const required = ["validation_required", "Cannot be blank."] as const;
const invalidFormat = [
  "validation_match_invalid",
  "Must be in a valid format.",
] as const;
const hasVia = [
  "validation_found_via",
  'The value cannot contain "_via_".',
] as const;

function addError(
  errors: Errors,
  path: Path,
  [code, message]: readonly [string, string],
  params?: object,
) {
  let node = errors;
  for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Errors;
  node[path.at(-1)!] = params ? { code, message, params } : { code, message };
}

function toRow(c: Collection): Row {
  const { id, name, type, system, created, updated, ...rest } = c;
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

function checkFieldName(name: unknown): readonly [string, string] | null {
  if (typeof name !== "string" || name === "") return required;
  if (name.length > 100)
    return [
      "validation_length_out_of_range",
      "The length must be between 1 and 100.",
    ];
  if (!NAME_PATTERN.test(name)) return invalidFormat;
  if (RESERVED_FIELD_NAMES.includes(name))
    return ["validation_not_in_invalid", "Must not be in list."];
  if (name.toLowerCase().includes("_via_")) return hasVia;
  return null;
}

function checkRule(rule: unknown): readonly [string, string] | null {
  if (typeof rule !== "string" || rule === "") return null;
  try {
    parseFilter(rule);
    return null;
  } catch (e) {
    if (!(e instanceof FilterError)) throw e;
    return ["validation_invalid_rule", `Invalid rule. Raw error: ${e.message}`];
  }
}

function withFieldIds(fields: Field[]): Field[] {
  const used = new Set(fields.map((f) => f.id).filter(Boolean));
  return fields.map((f) => {
    const base: Field = {
      ...f,
      system: f.system ?? false,
      hidden: f.hidden ?? false,
      presentable: f.presentable ?? false,
    };
    if (base.id) return base;
    const root = fieldId(f.type, f.name);
    let id = root;
    for (let i = 2; used.has(id); i++) id = root + i;
    used.add(id);
    return { ...base, id };
  });
}

function ensureSystemFields(c: Collection) {
  if (c.type === "view") return;
  const fields = [...c.fields];
  const at = (name: string) => fields.findIndex((f) => f.name === name);

  const idAt = at("id");
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

export class CollectionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS _collections (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL, system INTEGER NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS _params (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    if (!this.find("_superusers")) this.save(superusersScaffold());
  }

  all(): Collection[] {
    return this.db
      .query<Row>("SELECT * FROM _collections ORDER BY rowid")
      .map(fromRow);
  }

  find(nameOrId: string): Collection | null {
    const row = this.db.get<Row>(
      "SELECT * FROM _collections WHERE id = ?1 OR name = ?1 COLLATE NOCASE",
      [nameOrId],
    );
    return row ? fromRow(row) : null;
  }

  save(input: Partial<Collection> & { name: string }): Collection {
    return this.db.tx(() => {
      const old = input.id ? this.find(input.id) : null;
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

      next.fields = withFieldIds((input.fields ?? next.fields) as Field[]);
      next.indexes = next.indexes ?? [];
      ensureSystemFields(next);
      next.indexes = next.indexes.map((sql) => {
        const parsed = parseIndex(sql);
        return parsed ? buildIndex({ ...parsed, table: next.name }) : sql;
      });

      this.validate(old, next);

      syncTable(this.db, old, next);
      const row = toRow(next);
      this.db.run(
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
      );
      return next;
    });
  }

  delete(nameOrId: string): void {
    const c = this.require(nameOrId);
    if (c.system) throw new ValidationError("Failed to delete collection.");
    this.db.tx(() => {
      dropTable(this.db, c);
      this.db.run("DELETE FROM _collections WHERE id = ?", [c.id]);
    });
  }

  truncate(nameOrId: string): void {
    const c = this.require(nameOrId);
    if (c.type === "view")
      throw new ValidationError("Failed to truncate collection.");
    this.db.run(`DELETE FROM ${quote(c.name)}`);
  }

  private require(nameOrId: string): Collection {
    const c = this.find(nameOrId);
    if (!c) throw new ValidationError("Collection not found.");
    return c;
  }

  private freeId(type: string, name: string): string {
    const root = collectionId(type, name);
    let id = root;
    for (
      let i = 1;
      this.db.get("SELECT 1 FROM _collections WHERE id = ?", [id]);
      i++
    )
      id = root + i;
    return id;
  }

  private validate(old: Collection | null, next: Collection) {
    const errors: Errors = {};
    const isNew = !old;

    if (isNew) {
      if (next.id.length > 100 || !ID_PATTERN.test(next.id))
        addError(errors, ["id"], invalidFormat);
      else if (
        this.db.get("SELECT 1 FROM _collections WHERE id = ?", [next.id])
      ) {
        addError(
          errors,
          ["id"],
          ["validation_not_unique", "Value must be unique."],
        );
      }
    }
    if (old && next.system !== old.system) {
      addError(
        errors,
        ["system"],
        [
          "validation_collection_system_flag_change",
          "System collection state cannot be changed.",
        ],
      );
    }
    if (!["base", "auth", "view"].includes(next.type)) {
      addError(
        errors,
        ["type"],
        ["validation_in_invalid", "Must be a valid value."],
      );
    } else if (old && next.type !== old.type) {
      addError(
        errors,
        ["type"],
        [
          "validation_collection_type_change",
          "Collection type cannot be changed.",
        ],
      );
    }

    this.validateName(errors, old, next);
    this.validateFields(errors, old, next);

    for (const key of RULES) {
      if (
        next.type === "view" &&
        key !== "listRule" &&
        key !== "viewRule" &&
        next[key] !== null
      ) {
        addError(errors, [key], ["validation_not_nil", "Must be blank."]);
        continue;
      }
      const err = checkRule(next[key]);
      if (err) addError(errors, [key], err);
      else if (old?.system && next[key] !== old[key]) {
        addError(
          errors,
          [key],
          [
            "validation_collection_system_rule_change",
            "System collection API rule cannot be changed.",
          ],
        );
      }
    }
    if (next.type === "auth") {
      for (const key of AUTH_RULES) {
        const err = checkRule(next[key]);
        if (err) addError(errors, [key], err);
        else if (old?.system && next[key] !== old[key]) {
          addError(
            errors,
            [key],
            [
              "validation_collection_system_rule_change",
              "System collection API rule cannot be changed.",
            ],
          );
        }
      }
    }

    this.validateIndexes(errors, old, next);

    if (Object.keys(errors).length > 0) {
      throw new ValidationError(
        `Failed to ${isNew ? "create" : "update"} collection.`,
        errors,
      );
    }
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
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? COLLATE NOCASE",
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
    const fields = next.fields;
    const fieldsError = (err: readonly [string, string]) =>
      addError(errors, ["fields"], err);

    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [i, f] of fields.entries()) {
      if (ids.has(f.id)) {
        return addError(
          errors,
          ["fields", i, "id"],
          [
            "validation_duplicated_field_id",
            `Duplicated or invalid field id "${f.id}"`,
          ],
        );
      }
      const lower = String(f.name).toLowerCase();
      if (names.has(lower)) {
        return addError(
          errors,
          ["fields", i, "name"],
          [
            "validation_duplicated_field_name",
            `Duplicated or invalid field name ${f.name}`,
          ],
          { fieldName: f.name },
        );
      }
      ids.add(f.id);
      names.add(lower);
    }

    if (next.type !== "view") {
      const id = fields.find((f) => f.name === "id");
      if (!id || id.type !== "text" || !id.primaryKey) {
        return fieldsError([
          "validation_missing_primary_key",
          'Missing or invalid "id" PK field.',
        ]);
      }
    }
    if (next.type === "auth") {
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
          return fieldsError([
            `validation_missing_${name}_field`,
            `System "${name}" field is required.`,
          ]);
        }
        if (
          !f.system ||
          ((name === "password" || name === "tokenKey") && !f.hidden)
        ) {
          return addError(
            errors,
            ["fields", fields.indexOf(f), "system"],
            ["validation_must_be_system", "Must be a system field."],
          );
        }
      }
    }

    if (old && next.type !== "view") {
      for (const oldField of old.fields.filter((f) => f.system)) {
        const f = fields.find((x) => x.id === oldField.id);
        if (!f || f.name !== oldField.name) {
          return fieldsError([
            "validation_system_field_change",
            "System fields cannot be deleted or renamed.",
          ]);
        }
      }
      for (const [i, f] of fields.entries()) {
        const oldField = old.fields.find((x) => x.id === f.id);
        if (oldField && oldField.type !== f.type) {
          addError(
            errors,
            ["fields", i],
            ["validation_field_type_change", "Field type cannot be changed."],
          );
        }
      }
    }

    if (next.type === "auth") {
      for (const [i, f] of fields.entries()) {
        if (RESERVED_AUTH_NAMES.includes(f.name)) {
          addError(
            errors,
            ["fields", i, "name"],
            [
              "validation_reserved_field_name",
              "The field name is reserved and cannot be used.",
            ],
          );
        }
      }
    }

    for (const [i, f] of fields.entries()) {
      const err = checkFieldName(f.name);
      if (err) addError(errors, ["fields", i, "name"], err);
    }
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
