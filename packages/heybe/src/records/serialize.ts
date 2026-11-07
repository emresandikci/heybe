import type { Collection } from "../collections/model";

export interface SerializeOpts {
  isSuperuser: boolean;
  isOwner: boolean;
  fields?: string;
}

type Json = Record<string, unknown>;

export function serializeRecord(
  collection: Collection,
  row: Json,
  { isSuperuser, isOwner, fields }: SerializeOpts,
): Json {
  const out: Json = {};
  for (const field of collection.fields) {
    if (field.type === "password") continue;
    if (field.hidden && !isSuperuser) continue;
    out[field.name] = row[field.name];
  }

  if (collection.type === "auth") {
    delete out.tokenKey;
    if (!isSuperuser && !isOwner && row.emailVisibility !== true)
      delete out.email;
  }
  out.collectionId = collection.id;
  out.collectionName = collection.name;

  const sorted = sortKeys(out);
  return fields?.trim() ? pick(sorted, parseFields(fields)) : sorted;
}

const sortKeys = (obj: Json): Json =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

function parseFields(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((f) => f.trim().split(":")[0]!).filter((f) => f !== "");
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function pick(data: Json, fields: string[]): Json {
  const all = fields.includes("*");
  const result: Json = {};
  for (const [key, value] of Object.entries(data)) {
    const nested = fields
      .filter((f) => f.startsWith(key + "."))
      .map((f) => f.slice(key.length + 1));
    if (fields.includes(key)) result[key] = value;
    else if (nested.length > 0 && isObject(value))
      result[key] = pick(value, nested);
    else if (nested.length > 0 && Array.isArray(value))
      result[key] = value.map((v) => (isObject(v) ? pick(v, nested) : v));
    else if (all) result[key] = value;
  }
  return result;
}
