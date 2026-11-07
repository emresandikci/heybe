import { sqlType } from "../collections/ddl";
import { type FieldDef, fail, required } from "./shared";

const DEFAULT_MAX_SIZE = 1 << 20;
const EMPTY = ["null", '""', "[]", "{}", ""];
const encoder = new TextEncoder();

function parseText(text: string): unknown {
  if (text === "" || text === "null" || text === "true" || text === "false")
    return text === "" ? "" : JSON.parse(text);
  if (/^[\d\-"[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  return text;
}

export const json: FieldDef = {
  sqlType: sqlType("json"),
  normalize: (value) =>
    typeof value === "string" ? parseText(value) : (value ?? null),
  validate(value, field) {
    const serialized = JSON.stringify(value) ?? "null";
    const maxSize =
      Number(field.maxSize) > 0 ? Number(field.maxSize) : DEFAULT_MAX_SIZE;
    if (encoder.encode(serialized).length > maxSize) {
      return fail(
        "validation_json_size_limit",
        "The maximum allowed JSON size is {{.maxSize}} bytes",
        { maxSize },
      );
    }
    if (field.required === true && EMPTY.includes(serialized.trim()))
      return required();
    return null;
  },
  toDb: (value) =>
    value === null || value === undefined ? null : JSON.stringify(value),
  fromDb(raw) {
    if (typeof raw !== "string" || raw === "") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },
};
