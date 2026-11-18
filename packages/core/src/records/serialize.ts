import type { Collection } from "../collections/model";
import { ValidationError } from "../util";
import { tokenize as tokenizeRaw } from "../tokenizer";
import { excerpt } from "./excerpt";
import { PasswordValue } from "../fields/password";

export interface SerializeOpts {
  isSuperuser: boolean;
  isOwner: boolean;
  fields?: string;
}

type Json = Record<string, unknown>;

// PB exports a password field (non-auth collections only) as its plain value
export const plain = (value: unknown): string =>
  value instanceof PasswordValue ? value.plain : "";

export function serializeRecord(
  collection: Collection,
  row: Json,
  { isSuperuser, isOwner, fields }: SerializeOpts,
): Json {
  const out: Json = {};
  for (const field of collection.fields) {
    if (field.type === "password" && collection.type === "auth") continue;
    if (field.hidden && !isSuperuser) continue;
    out[field.name] =
      field.type === "password" ? plain(row[field.name]) : row[field.name];
  }

  if (collection.type === "auth") {
    delete out.tokenKey;
    if (!isSuperuser && !isOwner && row.emailVisibility !== true)
      delete out.email;
  }
  out.collectionId = collection.id;
  out.collectionName = collection.name;

  return pickFields(sortKeys(out), fields);
}

// Port of PB tools/picker: `fields` query param with nested paths, "*" and modifiers.
export function pickFields(data: Json, fields?: string | null): Json {
  return fields ? (pickAny(data, parseFields(fields)) as Json) : data;
}

export function pickItems(items: Json[], fields?: string | null): Json[] {
  return fields ? (pickAny(items, parseFields(fields)) as Json[]) : items;
}

export const sortKeys = (obj: Json): Json =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));

type Modifier = ((value: unknown) => unknown) | null;

// PB answers every picker error with its generic 400
const invalid = () => new ValidationError("");

function tokenize(
  input: string,
  separators: string,
  ignoreParenthesis = false,
): string[] {
  try {
    return tokenizeRaw(input, { separators, ignoreParenthesis });
  } catch {
    throw invalid();
  }
}

function toInt(s: string): number {
  return /^[+-]?\d+(\.0*)?$/.test(s) ? parseInt(s, 10) : 0;
}

function excerptModifier(args: string[]): Modifier {
  if (args.length === 0 || args.length > 2) throw invalid();
  const max = toInt(args[0]!);
  if (max <= 0) throw invalid();
  const withEllipsis =
    args.length > 1 && /^(1|t|T|TRUE|true|True)$/.test(args[1]!);
  return (value) =>
    typeof value === "string" ? excerpt(value, max, withEllipsis) : value;
}

function initModifier(raw: string): Modifier {
  const [name, ...args] = tokenize(raw, "(), ", true);
  if (name !== "excerpt") throw invalid();
  return excerptModifier(args);
}

function parseFields(raw: string): Map<string, Modifier> {
  const out = new Map<string, Modifier>();
  for (const f of tokenize(raw, ",")) {
    const i = f.indexOf(":");
    if (i < 0) out.set(f, null);
    else out.set(f.slice(0, i), initModifier(f.slice(i + 1)));
  }
  return out;
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function pickAny(data: unknown, fields: Map<string, Modifier>): unknown {
  if (isObject(data)) return pickMap(data, fields);
  if (Array.isArray(data) && data.length > 0 && isObject(data[0]))
    return data.map((item) => pickMap(item as Json, fields));
  return data;
}

function pickMap(data: Json, picked: Map<string, Modifier>): Json {
  if (picked.size === 0) return data;
  const fields = new Map(picked);
  if (fields.has("*")) {
    const all = fields.get("*")!;
    for (const k of Object.keys(data)) {
      const listed = [...fields.keys()].some((f) =>
        (f + ".").startsWith(k + "."),
      );
      if (!listed) fields.set(k, all);
    }
  }

  const result: Json = {};
  for (const [k, value] of Object.entries(data)) {
    const nested = new Map<string, Modifier>();
    let whole: { m: Modifier } | null = null;
    for (const [f, m] of fields) {
      if (!(f + ".").startsWith(k + ".")) continue;
      const remains = (f + ".").slice(k.length + 1).replace(/\.$/, "");
      if (remains === "") whole = { m };
      else nested.set(remains, m);
    }
    if (whole) result[k] = whole.m ? whole.m(value) : value;
    else if (nested.size > 0) result[k] = pickAny(value, nested);
  }
  return result;
}
