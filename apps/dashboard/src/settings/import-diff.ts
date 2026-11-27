import type { CollectionModel } from "@heybejs/client";
import {
  FIELD_TYPES,
  fieldDefaults,
  type FieldType,
} from "../collections/field-types";

type Field = Record<string, unknown>;

export interface FieldsDiff {
  added: string[];
  changed: string[];
  deleted: string[];
}

export interface CollectionChange {
  name: string;
  previousName?: string;
  fields: FieldsDiff;
}

export interface ImportDiff {
  added: string[];
  changed: CollectionChange[];
  deleted: string[];
}

export function parseImport(text: string): Partial<CollectionModel>[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const reason = (err as Error).message.replace(/\.$/, "");
    throw new Error(`Invalid collections JSON: ${reason}.`);
  }
  if (!Array.isArray(data))
    throw new Error("Invalid collections JSON: expected an array.");
  data.forEach((item: unknown, i) => {
    const name = (item as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !name)
      throw new Error(`Invalid collections JSON: item ${i + 1} has no name.`);
  });
  return data as Partial<CollectionModel>[];
}

export function exportJson(collections: CollectionModel[]): string {
  return JSON.stringify(
    collections.map(({ created: _c, updated: _u, ...rest }) => rest),
    null,
    2,
  );
}

const stable = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

const withoutMeta = ({
  id: _i,
  created: _c,
  updated: _u,
  fields: _f,
  ...rest
}: Partial<CollectionModel>) => rest;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(text: string): string {
  let crc = 0xffffffff;
  for (const byte of new TextEncoder().encode(text))
    crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return String((crc ^ 0xffffffff) >>> 0);
}

// Server addFields (PB FieldsList.Add): a field without id gets type + crc32(name) and
// replaces the field with the same name.
function addFields(list: Field[], fields: Field[]): Field[] {
  const out = [...list];
  for (const field of fields) {
    const f = { ...field };
    const byName = !f.id;
    if (byName) {
      const root = `${String(f.type)}${crc32(String(f.name ?? ""))}`;
      let id = root;
      for (let i = 2; i < 1000 && out.some((x) => x.id === id); i++)
        id = root + i;
      f.id = id;
    }
    const at = out.findIndex((x) =>
      byName ? f.name !== "" && x.name === f.name : x.id === f.id,
    );
    if (at >= 0) {
      if (byName) f.id = out[at]!.id;
      out[at] = f;
    } else out.push(f);
  }
  return out;
}

// Server importInput: the imported fields, then each existing field not matched by id is kept
// (taking over a same name and type field), unless deleteMissing drops it and it is not system.
function mergeFields(
  existing: Field[],
  incoming: Field[] | null | undefined,
  deleteMissing: boolean,
): Field[] {
  let fields = addFields([], incoming ?? []);
  for (const f of existing) {
    if (!f.system && deleteMissing) continue;
    if (fields.some((m) => m.id === f.id)) continue;
    const found = fields.find((m) => m.name === f.name);
    if (found && found.type === f.type) found.id = f.id;
    fields = addFields(fields, [f]);
  }
  return fields;
}

// the server fills options a field leaves out with their defaults
function withDefaults(f: Field): Field {
  if (!FIELD_TYPES.some((t) => t.type === f.type)) return f;
  const { _key, ...defaults } = fieldDefaults(f.type as FieldType);
  return { ...defaults, ...f };
}

function diffFields(
  existing: Field[],
  incoming: Field[] | null | undefined,
  deleteMissing: boolean,
): FieldsDiff {
  const merged = mergeFields(existing, incoming, deleteMissing);
  const diff: FieldsDiff = { added: [], changed: [], deleted: [] };
  for (const f of merged) {
    const old = existing.find((e) => e.id === f.id);
    if (!old) diff.added.push(String(f.name));
    else if (old.name !== f.name)
      diff.changed.push(`${String(old.name)} -> ${String(f.name)}`);
    else if (stable(withDefaults(f)) !== stable(withDefaults(old)))
      diff.changed.push(String(f.name));
  }
  for (const e of existing)
    if (!merged.some((f) => f.id === e.id)) diff.deleted.push(String(e.name));
  return diff;
}

export function diffImport(
  current: CollectionModel[],
  incoming: Partial<CollectionModel>[],
  deleteMissing: boolean,
): ImportDiff {
  const diff: ImportDiff = { added: [], changed: [], deleted: [] };
  const matched = new Set<CollectionModel>();
  for (const item of incoming) {
    const key = String(item.id || item.name);
    const old = current.find(
      (c) => c.id === key || c.name.toLowerCase() === key.toLowerCase(),
    );
    if (!old) {
      diff.added.push(String(item.name));
      continue;
    }
    matched.add(old);
    // the server derives view fields from viewQuery
    const fields =
      (item.type ?? old.type) === "view"
        ? { added: [], changed: [], deleted: [] }
        : diffFields(old.fields, item.fields, deleteMissing);
    const props =
      stable(withoutMeta({ ...old, ...item })) !== stable(withoutMeta(old));
    if (
      props ||
      fields.added.length + fields.changed.length + fields.deleted.length > 0
    ) {
      const name = String(item.name ?? old.name);
      diff.changed.push(
        name === old.name
          ? { name, fields }
          : { name, previousName: old.name, fields },
      );
    }
  }
  if (deleteMissing)
    for (const c of current)
      if (!matched.has(c) && !c.system) diff.deleted.push(c.name);
  return diff;
}
