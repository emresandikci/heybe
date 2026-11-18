import { sqlType } from "../collections/ddl";
import { formatDate } from "../util";
import { type FieldDef, fail, required, unsupportedType } from "./shared";

const DATE =
  /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}(?:\.\d+)?))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export function parseDate(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value * 1000);
  else if (typeof value === "string") {
    const m = DATE.exec(value.trim());
    if (!m) return null;
    const tz = m[4] ? m[4].toUpperCase() : "Z";
    const offset = /^[+-]\d{4}$/.test(tz)
      ? `${tz.slice(0, 3)}:${tz.slice(3)}`
      : tz;
    date = new Date(`${m[1]}T${m[2] ?? "00:00"}:${m[3] ?? "00"}${offset}`);
  } else return null;
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeDate(value: unknown): string {
  const date = parseDate(value);
  return date ? formatDate(date) : "";
}

function goTime(date: Date): string {
  const [day, time] = formatDate(date).slice(0, -1).split(" ") as [
    string,
    string,
  ];
  const fraction = time.slice(9).replace(/0+$/, "");
  return `${day} ${time.slice(0, 8)}${fraction ? "." + fraction : ""} +0000 UTC`;
}

// Go time.Time JSON (RFC 3339 with trailing zero fractions removed)
const goJson = (date: Date) => date.toISOString().replace(/\.?0+Z$/, "Z");

export const date: FieldDef = {
  sqlType: sqlType("date"),
  normalize: normalizeDate,
  validate(value, field) {
    if (typeof value !== "string") return unsupportedType();
    const current = parseDate(value);
    if (!current) return field.required === true ? required() : null;

    const min = parseDate(field.min);
    if (min && current < min) {
      return fail(
        "validation_min_greater_equal_than_required",
        "Must be no less than {{.threshold}}.",
        { threshold: goTime(min) },
        { threshold: goJson(min) },
      );
    }
    const max = parseDate(field.max);
    if (max && current > max) {
      return fail(
        "validation_max_less_equal_than_required",
        "Must be no greater than {{.threshold}}.",
        { threshold: goTime(max) },
        { threshold: goJson(max) },
      );
    }
    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => (typeof raw === "string" ? raw : ""),
};
