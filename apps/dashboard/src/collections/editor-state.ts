import type { CollectionModel } from "@heybe/client";
import { fieldDefaults, nextKey, type FieldType } from "./field-types";
import { IDENT, quote, randomIndexName, unquote } from "./index-sql";

export type { FieldType };
export type CollectionType = CollectionModel["type"];

export type FieldModel = {
  id?: string;
  _key: string;
  _removed?: boolean;
  _original?: string;
  name: string;
  type: FieldType;
  system: boolean;
  hidden: boolean;
  presentable: boolean;
  [option: string]: unknown;
};

export type CollectionDraft = {
  id: string;
  name: string;
  _originalName: string;
  type: CollectionType;
  system: boolean;
  indexes: string[];
  fields: FieldModel[];
  [key: string]: unknown;
};

export interface Changes {
  renamedCollection: [string, string] | null;
  deletedFields: string[];
  renamedFields: [string, string][];
  changedRules: string[];
}

const RULES = [
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
  "authRule",
  "manageRule",
];

const ON = new RegExp(`\\bON\\s+(${IDENT})`, "i");
const INDEX_NAME = new RegExp(
  `(\\bINDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(${IDENT})`,
  "i",
);
const TOKEN = new RegExp(`'(?:[^']|'')*'|${IDENT}`, "g");

function rewriteIndex(
  sql: string,
  table: [string, string],
  columns: Map<string, string>,
): string {
  const on = ON.exec(sql);
  if (!on) return sql;
  const at = on.index + on[0].length;
  const [from, to] = table;
  const head =
    from !== to && unquote(on[1]!).toLowerCase() === from.toLowerCase()
      ? sql.slice(0, at - on[1]!.length) + quote(to)
      : sql.slice(0, at);
  const rest = sql.slice(at).replace(TOKEN, (token, offset: number, all) => {
    if (token.startsWith("'")) return token;
    const name = columns.get(unquote(token).toLowerCase());
    const isFunction = /^\s*\(/.test(all.slice(offset + token.length));
    return name === undefined || isFunction ? token : quote(name);
  });
  return head + rest;
}

const NEW_FIELD: Partial<Record<FieldType, Record<string, unknown>>> = {
  select: { maxSelect: 1 },
  relation: { maxSelect: 1 },
  file: { maxSelect: 1 },
  autodate: { onCreate: true },
};

export function draftFrom(c: CollectionModel): CollectionDraft {
  const copy = structuredClone(c);
  return {
    ...copy,
    _originalName: c.name,
    fields: copy.fields.map(
      (f) => ({ ...f, _key: nextKey(), _original: f.name }) as FieldModel,
    ),
  };
}

export function newDraft(
  type: CollectionType,
  scaffolds: Record<string, CollectionModel>,
): CollectionDraft {
  return draftFrom(scaffolds[type]!);
}

export function duplicateDraft(c: CollectionModel): CollectionDraft {
  const d = draftFrom(c);
  return {
    ...d,
    id: "",
    name: `${c.name}_duplicate`,
    system: false,
    fields: d.fields.map(({ id: _id, ...f }) => f),
    indexes: d.indexes.map((sql) =>
      sql.replace(
        INDEX_NAME,
        (_, head: string) => head + quote(randomIndexName()),
      ),
    ),
  };
}

export function addField(d: CollectionDraft, type: FieldType): CollectionDraft {
  const taken = new Set(d.fields.map((f) => f.name.toLowerCase()));
  let name = "field";
  for (let i = 2; taken.has(name); i++) name = `field${i}`;
  return {
    ...d,
    fields: [...d.fields, { ...fieldDefaults(type), ...NEW_FIELD[type], name }],
  };
}

export function renameField(
  d: CollectionDraft,
  key: string,
  name: string,
): CollectionDraft {
  return {
    ...d,
    fields: d.fields.map((f) => (f._key === key ? { ...f, name } : f)),
  };
}

export function renameCollection(
  d: CollectionDraft,
  name: string,
): CollectionDraft {
  return { ...d, name };
}

export function moveField(
  d: CollectionDraft,
  key: string,
  by: -1 | 1,
): CollectionDraft {
  const i = d.fields.findIndex((f) => f._key === key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.fields.length) return d;
  const fields = [...d.fields];
  [fields[i], fields[j]] = [fields[j]!, fields[i]!];
  return { ...d, fields };
}

export function removeField(d: CollectionDraft, key: string): CollectionDraft {
  const field = d.fields.find((f) => f._key === key);
  if (!field || field.system) return d;
  return {
    ...d,
    fields: field.id
      ? d.fields.map((f) => (f._key === key ? { ...f, _removed: true } : f))
      : d.fields.filter((f) => f._key !== key),
  };
}

export function restoreField(d: CollectionDraft, key: string): CollectionDraft {
  return {
    ...d,
    fields: d.fields.map((f) =>
      f._key === key ? { ...f, _removed: false } : f,
    ),
  };
}

export function activeFields(d: CollectionDraft): FieldModel[] {
  return d.fields.filter((f) => !f._removed);
}

// Index SQL keeps the names the collection was loaded with; renames are applied once here, so swaps and prefixes cannot collide.
export function finalIndexes(d: CollectionDraft): string[] {
  const columns = new Map<string, string>();
  for (const f of d.fields)
    if (f._original !== undefined && f._original !== f.name)
      columns.set(f._original.toLowerCase(), f.name);
  return d.indexes.map((sql) =>
    rewriteIndex(sql, [d._originalName, d.name], columns),
  );
}

// Takes indexes in current names (as finalIndexes shows them) and makes the current names the base for later renames.
export function setIndexes(
  d: CollectionDraft,
  indexes: string[],
): CollectionDraft {
  return {
    ...d,
    _originalName: d.name,
    fields: d.fields.map((f) => ({ ...f, _original: f.name })),
    indexes,
  };
}

export function toPayload(d: CollectionDraft): Partial<CollectionModel> {
  const {
    id,
    _originalName,
    created: _c,
    updated: _u,
    fields: _f,
    ...rest
  } = d;
  return {
    ...(id ? { id } : {}),
    ...rest,
    indexes: finalIndexes(d),
    ...(d.type === "view"
      ? {}
      : {
          fields: activeFields(d).map(
            ({ _key, _removed, _original, ...f }) => f,
          ),
        }),
  };
}

export function diffCollection(
  old: CollectionModel,
  d: CollectionDraft,
): Changes {
  const active = activeFields(d);
  const renamedFields: [string, string][] = [];
  const deletedFields: string[] = [];
  for (const f of old.fields) {
    const next = active.find((n) => n.id && n.id === f.id);
    if (!next) deletedFields.push(String(f.name));
    else if (next.name !== f.name)
      renamedFields.push([String(f.name), next.name]);
  }
  return {
    renamedCollection: old.name !== d.name ? [old.name, d.name] : null,
    deletedFields,
    renamedFields,
    changedRules: RULES.filter((k) => (old[k] ?? null) !== (d[k] ?? null)),
  };
}

export function hasChanges(c: Changes): boolean {
  return (
    !!c.renamedCollection ||
    c.deletedFields.length > 0 ||
    c.renamedFields.length > 0 ||
    c.changedRules.length > 0
  );
}
