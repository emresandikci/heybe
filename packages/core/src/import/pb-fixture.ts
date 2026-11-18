import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pb from "./testdata/pb-0.41.1.json" with { type: "json" };

type Obj = Record<string, unknown>;

export const PB_DEFAULT_SETTINGS: Obj = pb.settings;
export const PB_SYSTEM_COLLECTIONS: Obj[] = pb.collections;

const RULES = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
] as const;

function columnDef(field: Obj): string {
  const name = `\`${String(field.name)}\``;
  if (field.name === "id") return `${name} TEXT PRIMARY KEY NOT NULL`;
  const multiple =
    (field.type === "select" || field.type === "relation") &&
    Number(field.maxSelect ?? 1) > 1;
  switch (field.type) {
    case "number":
      return `${name} NUMERIC DEFAULT 0 NOT NULL`;
    case "bool":
      return `${name} BOOLEAN DEFAULT FALSE NOT NULL`;
    case "json":
      return `${name} JSON DEFAULT NULL`;
    case "geoPoint":
      return `${name} JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL`;
    case "file":
      return Number(field.maxSelect ?? 1) > 1
        ? `${name} JSON DEFAULT '[]' NOT NULL`
        : `${name} TEXT DEFAULT '' NOT NULL`;
    default:
      return multiple
        ? `${name} JSON DEFAULT '[]' NOT NULL`
        : `${name} TEXT DEFAULT '' NOT NULL`;
  }
}

const sqlValue = (v: unknown) =>
  typeof v === "boolean"
    ? Number(v)
    : v !== null && typeof v === "object"
      ? JSON.stringify(v)
      : (v as string | number | null);

// A data dir shaped like one PB 0.41.1 creates: its schema and system collections, the given
// collections (PB item format, tables built from their fields), rows, settings and storage files.
// String settings are stored as they are, like PB's encrypted value.
export function writePbDataDir(
  dir: string,
  spec: {
    collections?: Obj[];
    rows?: Record<string, Obj[]>;
    settings?: Obj | string;
    files?: Record<string, string>;
  },
): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.db"));
  try {
    db.run("PRAGMA journal_mode = WAL");
    for (const sql of pb.schema) db.run(sql);
    const insertCollection = db.prepare(
      "INSERT OR REPLACE INTO _collections (id, system, type, name, fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule, options, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of pb.collections)
      insertCollection.run(
        c.id,
        c.system,
        c.type,
        c.name,
        c.fields,
        c.indexes,
        c.listRule,
        c.viewRule,
        c.createRule,
        c.updateRule,
        c.deleteRule,
        c.options,
        c.created,
        c.updated,
      );
    for (const c of spec.collections ?? []) {
      const { id, system, type, name, fields, indexes, created, updated } = c;
      const options = { ...c };
      for (const k of [
        "id",
        "system",
        "type",
        "name",
        "fields",
        "indexes",
        "created",
        "updated",
        ...RULES,
      ])
        delete options[k];
      insertCollection.run(
        String(id),
        Number(!!system),
        String(type ?? "base"),
        String(name),
        JSON.stringify(fields ?? []),
        JSON.stringify(indexes ?? []),
        ...RULES.map((r) => (c[r] ?? null) as string | null),
        JSON.stringify(options),
        String(created ?? "2024-01-01 00:00:00.000Z"),
        String(updated ?? "2024-01-01 00:00:00.000Z"),
      );
      db.run(`DROP TABLE IF EXISTS \`${String(name)}\``);
      db.run(
        type === "view"
          ? `CREATE VIEW \`${String(name)}\` AS ${String(c.viewQuery)}`
          : `CREATE TABLE \`${String(name)}\` (${(fields as Obj[]).map(columnDef).join(", ")})`,
      );
    }
    for (const [table, rows] of Object.entries(spec.rows ?? {}))
      for (const row of rows) {
        const cols = Object.keys(row);
        db.run(
          `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
          cols.map((c) => sqlValue(row[c])),
        );
      }
    const settings = spec.settings ?? pb.settings;
    db.run("INSERT INTO _params (id, value) VALUES ('settings', ?)", [
      typeof settings === "string"
        ? settings
        : Buffer.from(JSON.stringify(settings)),
    ]);
  } finally {
    db.close();
  }
  for (const [path, content] of Object.entries(spec.files ?? {})) {
    const file = join(dir, "storage", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

export function encryptLikePb(text: string, key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}
