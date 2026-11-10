import type { CollectionModel } from "@heybe/client";
import type { CellField } from "./cell";

export type FormValues = Record<string, unknown>;

export class JsonInputError extends Error {
  constructor(readonly field: string) {
    super(`Invalid JSON in ${field}.`);
  }
}

export type FileValue = { removed: string[]; added: File[] };

const SKIPPED = ["autodate", "password"];

export const fieldsOf = (c: CollectionModel) => c.fields as CellField[];

export const isMulti = (f: CellField) => Number(f.maxSelect) > 1;

export function expandOf(c: CollectionModel): Record<string, true> {
  return Object.fromEntries(
    fieldsOf(c)
      .filter((f) => !f.hidden && f.type === "relation")
      .map((f) => [f.name, true as const]),
  );
}

export function toServerDate(input: string): string {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d)(?::(\d\d))?/.exec(input);
  if (!match) return "";
  return `${match[1]} ${match[2]}:${match[3] ?? "00"}.000Z`;
}

export function toInputDate(server: string): string {
  const match = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/.exec(server);
  return match ? `${match[1]}T${match[2]}` : "";
}

function initialValue(f: CellField, v: unknown): unknown {
  switch (f.type) {
    case "number":
      return v === null || v === undefined ? "" : String(v);
    case "bool":
      return !!v;
    case "date":
      return toInputDate(String(v ?? ""));
    case "select":
    case "relation":
      return isMulti(f)
        ? Array.isArray(v)
          ? v
          : v
            ? [v]
            : []
        : Array.isArray(v)
          ? String(v[0] ?? "")
          : String(v ?? "");
    case "file":
      return { removed: [], added: [] } satisfies FileValue;
    case "json":
      return v === null || v === undefined || v === ""
        ? ""
        : JSON.stringify(v, null, 2);
    case "geoPoint": {
      const point = v as { lon?: number; lat?: number } | null | undefined;
      return {
        lon: point ? String(point.lon ?? 0) : "",
        lat: point ? String(point.lat ?? 0) : "",
      };
    }
    default:
      return String(v ?? "");
  }
}

export function initialValues(
  c: CollectionModel,
  record?: Record<string, unknown>,
): FormValues {
  const values: FormValues = {};
  for (const f of fieldsOf(c)) {
    if (f.type === "password") {
      values.password = "";
      values.passwordConfirm = "";
    } else if (!f.hidden) values[f.name] = initialValue(f, record?.[f.name]);
  }
  return values;
}

function toWriteValue(f: CellField, v: unknown): unknown {
  switch (f.type) {
    case "number":
      return v === "" ? null : Number(v);
    case "date":
      return toServerDate(String(v));
    case "json": {
      const text = String(v).trim();
      if (!text) return null;
      try {
        JSON.parse(text);
      } catch {
        throw new JsonInputError(f.name);
      }
      return text;
    }
    case "geoPoint": {
      const { lon, lat } = v as { lon: string; lat: string };
      return { lon: Number(lon || 0), lat: Number(lat || 0) };
    }
    default:
      return v;
  }
}

function fileData(
  f: CellField,
  { removed, added }: FileValue,
  create: boolean,
): Record<string, unknown> {
  const multi = isMulti(f);
  if (create) return added.length ? { [f.name]: multi ? added : added[0] } : {};
  if (!multi) {
    if (added.length) return { [f.name]: added[0] };
    return removed.length ? { [`${f.name}-`]: removed } : {};
  }
  return {
    ...(added.length && { [`${f.name}+`]: added }),
    ...(removed.length && { [`${f.name}-`]: removed }),
  };
}

const isEmpty = (f: CellField, v: unknown) => {
  if (f.type === "bool") return v === false;
  if (f.type === "geoPoint") {
    const { lon, lat } = v as { lon: string; lat: string };
    return lon === "" && lat === "";
  }
  if (Array.isArray(v)) return v.length === 0;
  return String(v).trim() === "";
};

export function toWriteData(
  c: CollectionModel,
  values: FormValues,
  original?: Record<string, unknown>,
): Record<string, unknown> {
  const initial = original ? initialValues(c, original) : undefined;
  const data: Record<string, unknown> = {};
  for (const f of fieldsOf(c)) {
    if (f.hidden || SKIPPED.includes(f.type) || !(f.name in values)) continue;
    const value = values[f.name];
    if (f.type === "file") {
      Object.assign(data, fileData(f, value as FileValue, !initial));
      continue;
    }
    const include = initial
      ? JSON.stringify(value) !== JSON.stringify(initial[f.name])
      : !isEmpty(f, value);
    if (include) data[f.name] = toWriteValue(f, value);
  }
  if (c.type === "auth" && values.password) {
    data.password = values.password;
    data.passwordConfirm = values.passwordConfirm;
  }
  return data;
}
