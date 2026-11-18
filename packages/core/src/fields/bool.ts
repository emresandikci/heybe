import { sqlType } from "../collections/ddl";
import { type FieldDef, required, unsupportedType } from "./shared";

const TRUE = ["1", "t", "T", "TRUE", "true", "True"];

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return typeof value === "string" && TRUE.includes(value);
}

export const bool: FieldDef = {
  sqlType: sqlType("bool"),
  normalize: toBool,
  validate(value, field) {
    if (typeof value !== "boolean") return unsupportedType();
    return field.required === true && !value ? required() : null;
  },
  toDb: (value) => (value ? 1 : 0),
  fromDb: toBool,
};
