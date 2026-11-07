import { sqlType } from "../collections/ddl";
import { type FieldDef, fail, required, unsupportedType } from "./shared";

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return 0;
  if (NUMERIC.test(value)) return Number(value);
  if (/^[+-]?(inf|infinity)$/i.test(value))
    return value.startsWith("-") ? -Infinity : Infinity;
  if (/^nan$/i.test(value)) return Number.NaN;
  return 0;
}

export const number: FieldDef = {
  sqlType: sqlType("number"),
  normalize: toNumber,
  validate(value, field) {
    if (typeof value !== "number") return unsupportedType();
    if (!Number.isFinite(value))
      return fail(
        "validation_not_a_number",
        "The submitted number is not properly formatted",
      );
    if (value === 0) return field.required === true ? required() : null;

    if (field.onlyInt === true && !Number.isInteger(value))
      return fail(
        "validation_only_int_constraint",
        "Decimal numbers are not allowed",
      );
    if (typeof field.min === "number" && value < field.min) {
      return fail(
        "validation_min_number_constraint",
        "Must be greater or equal than {{.min}}",
        { min: field.min },
      );
    }
    if (typeof field.max === "number" && value > field.max) {
      return fail(
        "validation_max_number_constraint",
        "Must be less or equal than {{.max}}",
        { max: field.max },
      );
    }
    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => Number(raw ?? 0),
};
