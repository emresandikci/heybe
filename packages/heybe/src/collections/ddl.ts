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
  name: string;
  table: string;
  columns: string[];
  columnsSql: string;
  where: string;
}

const IDENT = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|\\w+)';
const HEAD = new RegExp(
  `^\\s*CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\.)?(${IDENT})\\s+ON\\s+(${IDENT})\\s*\\(`,
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
    name: unquote(head[2]!),
    table: unquote(head[3]!),
    columns: columns.map((c) => unquote(c!)),
    columnsSql,
    where,
  };
}

export function buildIndex(index: ParsedIndex): string {
  const where = index.where ? ` WHERE ${index.where}` : "";
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(index.table)} (${index.columnsSql})${where}`;
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
  const type = sqlType(field.type);
  return `${name} ${type} DEFAULT ${type === "TEXT" ? "''" : "0"} NOT NULL`;
}

function createIndexes(db: Db, c: Collection) {
  for (const sql of c.indexes) {
    const parsed = parseIndex(sql);
    if (parsed) db.run(buildIndex({ ...parsed, table: c.name }));
  }
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
        db.run(
          `ALTER TABLE ${quote(next.name)} DROP COLUMN ${quote(oldField.name)}`,
        );
      }
    }

    const renames: [string, string][] = [];
    next.fields.forEach((field, i) => {
      const oldField = old.fields.find((f) => f.id === field.id);
      const temp = `_sync_${i}`;
      if (!oldField) {
        db.run(
          `ALTER TABLE ${quote(next.name)} ADD COLUMN ${columnDef({ ...field, name: temp })}`,
        );
        renames.push([temp, field.name]);
      } else if (oldField.name !== field.name) {
        db.run(
          `ALTER TABLE ${quote(next.name)} RENAME COLUMN ${quote(oldField.name)} TO ${quote(temp)}`,
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
  if (c.type !== "view") db.run(`DROP TABLE IF EXISTS ${quote(c.name)}`);
}
