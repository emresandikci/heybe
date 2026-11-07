import type { Db } from "../db";
import type { Collection, Field } from "../collections/model";

export interface FieldError {
  code: string;
  message: string;
}

export interface FieldCtx {
  db: Db;
  collection: Collection;
  record: Record<string, unknown>;
  original?: Record<string, unknown>;
  isNew: boolean;
  now: () => Date;
  findCollection: (idOrName: string) => Collection | null;
}

export interface FieldDef {
  sqlType: "TEXT" | "REAL" | "INTEGER";
  normalize(value: unknown, field: Field): unknown;
  validate(value: unknown, field: Field, ctx: FieldCtx): FieldError | null;
  prepare?(value: unknown, field: Field): Promise<unknown>;
  toDb(value: unknown): unknown;
  fromDb(raw: unknown, field: Field): unknown;
}

const sentenize = (message: string) => {
  const text = message.trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.?!]$/.test(sentence) ? sentence : sentence + ".";
};

const display = (value: unknown) =>
  Array.isArray(value) ? `[${value.join(" ")}]` : String(value);

export function fail(
  code: string,
  message: string,
  params: Record<string, unknown> = {},
): FieldError {
  const filled = message.replace(/\{\{\.(\w+)\}\}/g, (_, key: string) =>
    display(params[key]),
  );
  return { code, message: sentenize(filled) };
}

export const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];

export const required = () => fail("validation_required", "cannot be blank");

export const unsupportedType = () =>
  fail(
    "validation_unsupported_value_type",
    "Invalid or unsupported value type.",
  );

export function toStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return "";
}

export function uniqueStrings(value: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") {
    if (value.includes("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        items = Array.isArray(parsed) ? parsed : [value];
      } catch {
        items = [value];
      }
    } else if (value !== "") items = [value];
  } else if (value !== null && value !== undefined) items = [value];
  return [...new Set(items.map(toStr).filter((s) => s !== ""))];
}

export const isMultiple = (field: Field) => Number(field.maxSelect) > 1;

export function singleOrList(field: Field, items: string[]): string | string[] {
  return isMultiple(field) ? items : (items[items.length - 1] ?? "");
}

export const listToDb = (value: unknown) =>
  Array.isArray(value) ? JSON.stringify(value) : value;

export function listFromDb(raw: unknown, field: Field): string | string[] {
  if (!isMultiple(field)) return toStr(raw);
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(toStr) : [];
  } catch {
    return [];
  }
}

export function validatePattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export const runeLength = (value: string) => [...value].length;
