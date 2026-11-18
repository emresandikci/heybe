import type { Db } from "../db";
import { jsonEach } from "../filter/resolve";
import { decode } from "../records/read";
import { serializeRecord } from "../records/serialize";
import { Tokenizer, tokenize } from "../tokenizer";
import { randomSecret } from "../util";
import { quote, sqliteMessage } from "./ddl";
import { rawErrors } from "./errors";
import {
  addFields,
  fieldDefaults,
  validateFieldSettings,
} from "./field-settings";
import {
  type Collection,
  type Field,
  type FieldType,
  collectionId,
} from "./model";
import { scaffold } from "./scaffold";

// Port of PB core/view.go and the view helpers of core/collection_query.go.

export interface ViewStore {
  all(): Collection[];
  find(nameOrId: string): Collection | null;
}

interface Identifier {
  original: string;
  alias: string;
}

interface QueryField {
  field: Field;
  collection?: Collection;
  original?: Field;
}

interface TableInfoRow {
  name: string;
  type: string;
}

const WS = "[\\t\\n\\f\\r ]";
const JOIN = new RegExp(
  `${WS}+(full${WS}+outer${WS}+join|left${WS}+outer${WS}+join|right${WS}+outer${WS}+join|full${WS}+join|cross${WS}+join|inner${WS}+join|outer${WS}+join|left${WS}+join|right${WS}+join|join)${WS}+?`,
  "gim",
);
const DISCARD = new RegExp(
  `${WS}+(where|group${WS}+by|having|order|limit|with)${WS}+?`,
  "gim",
);
const COMMENTS = /(\/\*[\s\S]*?\*\/)|(--[^\n]+$)/gm;
const CAST = new RegExp(`^cast${WS}*\\(.*${WS}+as${WS}+(\\w+)${WS}*\\)$`, "is");
const MISSING_ID =
  "missing required id column (you can use `(ROW_NUMBER() OVER()) as id` if you don't have one)";

const trimChars = (s: string, chars: string) => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
};

const asError = (e: unknown) => new Error(sqliteMessage(e));

function newField(type: FieldType, options: Record<string, unknown>): Field {
  return { ...fieldDefaults(type), id: "", ...options } as Field;
}

const viewIdField = () =>
  newField("text", {
    name: "id",
    system: true,
    required: true,
    primaryKey: true,
    pattern: "^[a-z0-9]+$",
  });

const defaultViewField = (name: string) =>
  name === "id" ? viewIdField() : newField("json", { name, maxSize: 1 });

export function normalizeViewSelectQuery(query: string): string {
  const trimmed = trimChars(query.trim(), ";");
  let parts: string[] = [];
  try {
    parts = tokenize(trimmed, { separators: ";" });
  } catch {}
  if (parts.length > 1)
    throw new Error("multiple statements are not supported");
  return trimmed;
}

export function deleteView(db: Db, name: string): void {
  db.run(`DROP VIEW IF EXISTS ${quote(name)}`);
}

function tableInfo(db: Db, name: string): TableInfoRow[] {
  const info = db.query<TableInfoRow>("SELECT * FROM PRAGMA_TABLE_INFO(?)", [
    name,
  ]);
  if (info.length === 0)
    throw new Error(
      `empty table info probably due to invalid or missing table ${name}`,
    );
  return info;
}

export function saveView(db: Db, name: string, query: string): void {
  db.tx(() => {
    deleteView(db, name);
    const normalized = normalizeViewSelectQuery(query);
    // the secondary SELECT discourages multiple inline statements
    db.run(`CREATE VIEW ${quote(name)} AS SELECT * FROM (${normalized})`);
    try {
      tableInfo(db, name);
    } catch (e) {
      deleteView(db, name);
      throw e;
    }
  });
}

function queryTableInfo(db: Db, query: string): TableInfoRow[] {
  const temp = "_temp_" + randomSecret(6);
  return db.tx(() => {
    saveView(db, temp, query);
    const info = tableInfo(db, temp);
    deleteView(db, temp);
    return info;
  });
}

function identifierFromParts(parts: string[]): Identifier {
  let original: string;
  let alias: string;
  if (parts.length === 3) {
    if (parts[1]!.toLowerCase() !== "as")
      throw new Error(
        `invalid identifier part - expected "as", got ${parts[1]}`,
      );
    original = parts[0]!;
    alias = parts[2]!;
  } else if (parts.length === 2) {
    original = parts[0]!;
    alias = parts[1]!;
  } else if (parts.length === 1) {
    original = parts[0]!;
    alias = parts[0]!.split(".").at(-1)!;
  } else {
    throw new Error(`invalid identifier parts [${parts.join(" ")}]`);
  }
  const trim = (raw: string, extra = "") =>
    raw
      .split(".")
      .map((p) => trimChars(p, '`"[];' + extra))
      .join(".");
  // SQLite accepts single quoted identifiers where an identifier is expected
  return { original: trim(original), alias: trim(alias, "'") };
}

const extractIdentifiers = (raw: string): Identifier[] =>
  tokenize(raw, { separators: "," }).map((item) =>
    identifierFromParts(tokenize(item, { separators: " \n\t" })),
  );

function parseIdentifiers(query: string): {
  columns: Identifier[];
  tables: Identifier[];
} {
  const str = trimChars(query.trim(), ";")
    .replace(COMMENTS, " ")
    .replace(JOIN, " __hb_join__ ")
    .replace(DISCARD, " __hb_discard__ ");

  const tk = new Tokenizer(str, {
    separators: ", \n\t",
    keepSeparator: true,
  });
  const parts = { select: "", from: "", join: "" };
  let skip = false;
  let active: keyof typeof parts | null = null;

  for (let token = tk.scan(); token !== null; token = tk.scan()) {
    const trimmed = token.trim().toLowerCase();
    if (trimmed === "distinct") continue;
    if (trimmed === "select" || trimmed === "from") {
      skip = false;
      active = trimmed;
    } else if (trimmed === "__hb_join__") {
      skip = false;
      if (active === "join") parts.join += ",";
      active = "join";
    } else if (trimmed === "__hb_discard__") {
      skip = true;
    } else {
      if (active === "join" && trimmed === "on") skip = true;
      if (!skip && active) parts[active] += " " + token;
    }
  }

  return {
    columns: extractIdentifiers(parts.select),
    tables: [
      ...extractIdentifiers(parts.from),
      ...extractIdentifiers(parts.join),
    ],
  };
}

function findCollectionsByIdentifiers(
  store: ViewStore,
  tables: Identifier[],
): Map<string, Collection> {
  const names = tables
    .filter((t) => !t.alias.includes("("))
    .map((t) => t.original);
  const result = new Map<string, Collection>();
  if (names.length === 0) return result;
  const found = store.all().filter((c) => names.includes(c.name));
  for (const table of tables) {
    for (const c of found)
      if (c.name === table.original) result.set(table.alias, c);
  }
  return result;
}

function castField(alias: string, colLower: string): Field | null {
  const type = CAST.exec(colLower)?.[1];
  switch (type) {
    case "real":
    case "decimal":
    case "numeric":
      return newField("number", { name: alias });
    case "int":
    case "integer":
      return newField("number", { name: alias, onlyInt: true });
    case "text":
      return newField("text", { name: alias });
    case "boolean":
    case "bool":
      return newField("bool", { name: alias });
  }
  return null;
}

function parseQueryToFields(
  store: ViewStore,
  query: string,
): Map<string, QueryField> {
  const { columns, tables } = parseIdentifiers(query);
  const collections = findCollectionsByIdentifiers(store, tables);
  const mainTable = tables[0];
  const result = new Map<string, QueryField>();

  for (const col of columns) {
    // no valid SQL aliases a * column, so the parsed alias is safe to check
    if (col.alias === "*")
      throw new Error(
        "wildcard columns (*) are not supported - manually type the collection field names you want the view query to have",
      );

    const alias = col.alias;
    const colLower = col.original.toLowerCase();

    if (alias === "id") {
      result.set(alias, { field: viewIdField() });
      continue;
    }
    if (colLower.startsWith("count(")) {
      result.set(alias, {
        field: newField("number", { name: alias, onlyInt: true }),
      });
      continue;
    }
    if (colLower.startsWith("total(")) {
      result.set(alias, { field: newField("number", { name: alias }) });
      continue;
    }
    const cast = castField(alias, colLower);
    if (cast) {
      result.set(alias, { field: cast });
      continue;
    }

    const parts = col.original.split(".");
    const fieldName = parts.length === 2 ? parts[1]! : parts[0]!;
    const collection =
      parts.length === 2
        ? collections.get(parts[0]!)
        : mainTable && collections.get(mainTable.alias);

    if (!collection) {
      result.set(alias, { field: defaultViewField(alias) });
      continue;
    }

    const lower = fieldName.toLowerCase();
    const field = collection.fields.find((f) => f.name.toLowerCase() === lower);
    if (!field) {
      result.set(alias, { field: defaultViewField(alias), collection });
      continue;
    }

    // an id reference becomes a relation
    if (lower === "id") {
      result.set(alias, {
        field: newField("relation", {
          name: alias,
          maxSelect: 1,
          collectionId: collection.id,
        }),
        collection,
      });
      continue;
    }

    result.set(alias, {
      original: field,
      // a new id keeps the field unique when it is aliased more than once
      field: {
        ...structuredClone(field),
        id: "_clone_" + randomSecret(4),
        name: alias,
      },
      collection,
    });
  }

  return result;
}

// PB CreateViewFields: on failure the fields resolved so far come back with the error.
export function createViewFields(
  db: Db,
  store: ViewStore,
  query: string,
): { fields: Field[]; error: Error | null } {
  let suggested: Map<string, QueryField>;
  try {
    suggested = parseQueryToFields(store, query);
  } catch (e) {
    return { fields: [], error: asError(e) };
  }

  let fields: Field[] = [];
  try {
    db.tx(() => {
      let hasId = false;
      for (const row of queryTableInfo(db, query)) {
        if (row.name === "id") hasId = true;
        const field =
          suggested.get(row.name)?.field ?? defaultViewField(row.name);
        fields = addFields(fields, [field]);
      }
      if (!hasId) throw new Error(MISSING_ID);
    });
  } catch (e) {
    return { fields, error: asError(e) };
  }
  return { fields, error: null };
}

export function inferViewFields(
  db: Db,
  store: ViewStore,
  query: string,
): Field[] {
  const { fields, error } = createViewFields(db, store, query);
  if (error) throw error;
  return fields;
}

// wraps the query when needed so that the id column is always TEXT
export function normalizeViewQueryId(db: Db, query: string): string {
  const trimmed = trimChars(query.trim(), ";");
  const info = queryTableInfo(db, trimmed);
  if (
    info.some(
      (r) => r.name.toLowerCase() === "id" && r.type.toLowerCase() === "text",
    )
  )
    return trimmed;

  const columns = parseIdentifiers(trimmed).columns.map((c) =>
    c.alias === "id"
      ? `CAST(${quote("id")} as TEXT) ${quote("id")}`
      : quote(c.alias),
  );
  return `SELECT ${columns.join(",")} FROM (${trimmed})`;
}

// ozzo-validation Errors.Error()
function ozzoMessage(errors: Record<string, unknown>): string {
  const parts = Object.keys(errors)
    .sort()
    .map((key) => {
      const v = errors[key];
      return typeof v === "string"
        ? `${key}: ${v}`
        : `${key}: (${ozzoMessage(v as Record<string, unknown>)})`;
    });
  return parts.join("; ") + ".";
}

export interface DryRunResult {
  fields: Field[];
  sample: Record<string, unknown>[];
}

export function dryRunView(
  db: Db,
  store: ViewStore,
  query: string,
  sampleSize: number,
): DryRunResult {
  let normalized = normalizeViewSelectQuery(query);
  const fields = inferViewFields(db, store, normalized);

  const tempName = "temp_view_" + randomSecret(5);
  const temp: Collection = {
    ...scaffold("view", tempName, collectionId("view", tempName)),
    fields,
  };

  fields.forEach((f, i) => {
    const errors = validateFieldSettings(f, {
      collection: temp,
      find: (idOrName) => store.find(idOrName),
    });
    if (Object.keys(errors).length > 0)
      throw new Error(
        `invalid field ${JSON.stringify(f.name)} (${i}): ${ozzoMessage(rawErrors(errors) as Record<string, unknown>)}`,
      );
  });

  try {
    normalized = normalizeViewQueryId(db, normalized);
  } catch (e) {
    throw new Error(`failed to normalize view query id: ${sqliteMessage(e)}`);
  }

  let rows: Record<string, unknown>[];
  try {
    rows = db.query(
      `SELECT ${quote(tempName)}.* FROM (SELECT * FROM (${normalized})) as ${quote(tempName)} LIMIT ?`,
      [sampleSize],
    );
  } catch (e) {
    throw new Error(`failed to retrieve query records: ${sqliteMessage(e)}`);
  }

  // a quick hint for the sample only, not a guarantee
  const ids = new Set<string>();
  const sample = rows.map((row) => {
    const values = decode(temp, row);
    const id = values.id as string;
    if (id === "")
      throw new Error(
        "the query could return records with empty or invalid ids",
      );
    if (ids.has(id))
      throw new Error("the query could return records with non-unique ids");
    ids.add(id);
    return serializeRecord(temp, values, {
      isSuperuser: false,
      isOwner: false,
    });
  });

  return { fields, sample };
}

// The source collection and record id that store a file served through a view.
export function findRecordByViewFile(
  db: Db,
  store: ViewStore,
  view: Collection,
  fileFieldName: string,
  filename: string,
): { collection: Collection; id: string } | null {
  let current = view;
  let fieldName = fileFieldName;
  // the depth limit stops circular view references
  for (let level = 1; level <= 5; level++) {
    const item = [
      ...parseQueryToFields(store, String(current.viewQuery ?? "")).values(),
    ].find((i) => i.collection && i.original && i.field.name === fieldName);
    if (!item) return null;

    const source = item.collection!;
    const original = item.original!;
    if (source.type === "view") {
      current = source;
      fieldName = original.name;
      continue;
    }

    const table = quote(source.name);
    const col = `${table}.${quote(original.name)}`;
    const row =
      Number(original.maxSelect) > 1
        ? db.get<{ id: string }>(
            `SELECT ${table}.id FROM ${table} INNER JOIN ${jsonEach(col)} AS _je_file ON _je_file.value = ? LIMIT 1`,
            [filename],
          )
        : db.get<{ id: string }>(
            `SELECT ${table}.id FROM ${table} WHERE ${col} = ? LIMIT 1`,
            [filename],
          );
    return row ? { collection: source, id: row.id } : null;
  }
  return null;
}
