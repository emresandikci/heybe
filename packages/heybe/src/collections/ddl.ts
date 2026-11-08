import type { Db } from "../db";
import type { Collection, Field, FieldType } from "./model";

export function sqlType(type: FieldType): "TEXT" | "REAL" | "INTEGER" {
  if (type === "number") return "REAL";
  if (type === "bool") return "INTEGER";
  return "TEXT";
}

export const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`";

export interface ParsedIndex {
  unique: boolean;
  optional: boolean;
  name: string;
  table: string;
  columns: string[];
  columnsSql: string;
  where: string;
}

const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|\\w+)';
const HEAD = new RegExp(
  `^\\s*CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\.)?(${IDENT})\\s+ON\\s+(${IDENT})\\s*\\(`,
  "i",
);
const WHERE = /^\s*WHERE\s+([\s\S]+?)\s*;?\s*$/i;

const unquote = (ident: string) =>
  /^[`"[]/.test(ident) ? ident.slice(1, -1) : ident;

export function parseIndex(sql: string): ParsedIndex | null {
  const head = HEAD.exec(sql);
  if (!head) return null;

  let depth = 1;
  let end = head[0].length;
  for (; end < sql.length && depth > 0; end++) {
    if (sql[end] === "(") depth++;
    else if (sql[end] === ")") depth--;
  }
  if (depth > 0) return null;

  const columnsSql = sql.slice(head[0].length, end - 1).trim();
  const tail = sql.slice(end);
  const where =
    tail.trim() === "" || tail.trim() === ";"
      ? ""
      : (WHERE.exec(tail)?.[1] ?? null);
  if (where === null || columnsSql === "") return null;

  const columns = columnsSql
    .split(",")
    .map((c) => new RegExp(`^\\s*(${IDENT})`).exec(c)?.[1]);
  if (columns.some((c) => !c)) return null;

  return {
    unique: !!head[1],
    optional: !!head[2],
    name: unquote(head[3]!),
    table: unquote(head[4]!),
    columns: columns.map((c) => unquote(c!)),
    columnsSql,
    where,
  };
}

const COLUMN = /^([\s\S]+?)(?:\s+collate\s+(\w+))?(?:\s+(asc|desc))?\s*$/i;
const TRIM = /^[`"'[\]\s]+|[`"'[\]\s]+$/g;

function splitColumns(sql: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = "";
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quoted) {
      if (ch === quoted) quoted = "";
    } else if (ch === "`" || ch === '"' || ch === "'") quoted = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(sql.slice(start));
  return parts;
}

// Same formatting as PB dbutils.Index.Build.
export function buildIndex(index: ParsedIndex): string {
  const columns = splitColumns(index.columnsSql)
    .map((raw) => COLUMN.exec(raw))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      name: m[1]!.replace(TRIM, ""),
      collate: m[2] ?? "",
      sort: (m[3] ?? "").toUpperCase(),
    }))
    .filter((c) => c.name !== "");
  const multi = columns.length > 1;
  const body = columns
    .map((c) => {
      const name = /[( ]/.test(c.name) ? c.name : quote(c.name);
      return (
        name +
        (c.collate ? ` COLLATE ${c.collate}` : "") +
        (c.sort ? ` ${c.sort}` : "")
      );
    })
    .join(",\n  ");
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.optional ? "IF NOT EXISTS " : ""}${quote(index.name)} ON ${quote(index.table)} (${multi ? "\n  " : ""}${body}${multi ? "\n" : ""})${where}`;
}

export function findSingleColumnUniqueIndex(
  indexes: string[],
  column: string,
): ParsedIndex | null {
  for (const sql of indexes) {
    const parsed = parseIndex(sql);
    if (
      parsed?.unique &&
      parsed.columns.length === 1 &&
      parsed.columns[0]!.toLowerCase() === column.toLowerCase()
    ) {
      return parsed;
    }
  }
  return null;
}

function columnDef(field: Field): string {
  const name = quote(field.name);
  if (field.name === "id") return `${name} TEXT PRIMARY KEY NOT NULL`;
  if (field.type === "json") return `${name} TEXT DEFAULT NULL`;
  if (field.type === "geoPoint")
    return `${name} JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL`;
  const type = sqlType(field.type);
  return `${name} ${type} DEFAULT ${type === "TEXT" ? "''" : "0"} NOT NULL`;
}

export class IndexErrors extends Error {
  constructor(readonly errors: Record<string, unknown>) {
    super("Failed to create indexes.");
  }
}

const SQLITE_PREFIX: Record<number, string> = {
  1: "SQL logic error",
  5: "database is locked",
  19: "constraint failed",
};

// Formats a bun:sqlite error like the Go driver PB uses: "<primary code text>: <message> (<extended code>)".
export function sqliteMessage(e: unknown): string {
  const { message, errno } = e as { message: string; errno?: number };
  if (typeof errno !== "number") return message;
  const prefix = SQLITE_PREFIX[errno & 0xff] ?? SQLITE_PREFIX[1];
  return `${prefix}: ${message} (${errno})`;
}

function createIndexes(db: Db, c: Collection) {
  const errors: Record<string, unknown> = {};
  c.indexes.forEach((sql, i) => {
    const parsed = parseIndex(sql);
    const invalid = (message: string) => {
      errors[i] = { code: "validation_invalid_index_expression", message };
    };
    if (!parsed) return invalid("Invalid CREATE INDEX expression.");
    try {
      db.run(buildIndex({ ...parsed, table: c.name }));
    } catch (e) {
      invalid(`Failed to create index ${parsed.name} - ${sqliteMessage(e)}.`);
    }
  });
  if (Object.keys(errors).length > 0) throw new IndexErrors(errors);
}

function dropIndexes(db: Db, c: Collection) {
  for (const sql of c.indexes) {
    const parsed = parseIndex(sql);
    if (parsed) db.run(`DROP INDEX IF EXISTS ${quote(parsed.name)}`);
  }
}

export function syncTable(
  db: Db,
  old: Collection | null,
  next: Collection,
): void {
  if (next.type === "view") return;

  db.tx(() => {
    if (!old) {
      db.run(
        `CREATE TABLE ${quote(next.name)} (${next.fields.map(columnDef).join(", ")})`,
      );
      createIndexes(db, next);
      return;
    }

    dropIndexes(db, old);

    if (old.name.toLowerCase() !== next.name.toLowerCase()) {
      db.run(`ALTER TABLE ${quote(old.name)} RENAME TO ${quote(next.name)}`);
    }

    for (const oldField of old.fields) {
      if (!next.fields.some((f) => f.id === oldField.id)) {
        runOrFail(
          db,
          `ALTER TABLE ${quote(next.name)} DROP COLUMN ${quote(oldField.name)}`,
          `failed to drop column ${oldField.name}`,
        );
      }
    }

    const renames: [string, string][] = [];
    next.fields.forEach((field, i) => {
      const oldField = old.fields.find((f) => f.id === field.id);
      const temp = `_sync_${i}`;
      if (!oldField) {
        runOrFail(
          db,
          `ALTER TABLE ${quote(next.name)} ADD COLUMN ${columnDef({ ...field, name: temp })}`,
          `failed to add column ${field.name}`,
        );
        renames.push([temp, field.name]);
      } else if (oldField.name !== field.name) {
        runOrFail(
          db,
          `ALTER TABLE ${quote(next.name)} RENAME COLUMN ${quote(oldField.name)} TO ${quote(temp)}`,
          `failed to rename column ${oldField.name}`,
        );
        renames.push([temp, field.name]);
      }
    });
    for (const [temp, name] of renames) {
      db.run(
        `ALTER TABLE ${quote(next.name)} RENAME COLUMN ${quote(temp)} TO ${quote(name)}`,
      );
    }

    createIndexes(db, next);
  });
}

export function dropTable(db: Db, c: Collection): void {
  db.run(
    `DROP ${c.type === "view" ? "VIEW" : "TABLE"} IF EXISTS ${quote(c.name)}`,
  );
}

function runOrFail(db: Db, sql: string, failure: string) {
  try {
    db.run(sql);
  } catch (e) {
    throw new Error(`${failure} - ${sqliteMessage(e)}`);
  }
}
