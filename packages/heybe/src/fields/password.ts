import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  required,
  runeLength,
  toStr,
  unsupportedType,
  validatePattern,
} from "./shared";

export class PasswordValue {
  constructor(
    readonly hash = "",
    readonly plain = "",
  ) {}
}

const DEFAULT_COST = 10;
const DEFAULT_MAX = 71;

export const password: FieldDef = {
  sqlType: sqlType("password"),
  normalize: (value) =>
    value instanceof PasswordValue
      ? value
      : new PasswordValue("", toStr(value)),
  async prepare(value, field) {
    if (!(value instanceof PasswordValue) || value.plain === "") return value;
    const cost = Number(field.cost) > 0 ? Number(field.cost) : DEFAULT_COST;
    return new PasswordValue(
      await Bun.password.hash(value.plain, { algorithm: "bcrypt", cost }),
    );
  },
  validate(value, field) {
    if (!(value instanceof PasswordValue)) return unsupportedType();
    if (field.required === true && value.hash === "" && value.plain === "")
      return required();
    if (value.plain === "") return null;

    const length = runeLength(value.plain);
    const min = Number(field.min) || 0;
    if (length < min)
      return fail(
        "validation_min_text_constraint",
        `Must be at least ${min} character(s)`,
      );

    const max = Number(field.max) > 0 ? Number(field.max) : DEFAULT_MAX;
    if (length > max)
      return fail(
        "validation_max_text_constraint",
        `Must be less than ${max} character(s)`,
      );

    const pattern = typeof field.pattern === "string" ? field.pattern : "";
    if (pattern !== "" && !validatePattern(pattern, value.plain))
      return fail("validation_invalid_format", "Invalid value format");
    return null;
  },
  toDb: (value) => (value instanceof PasswordValue ? value.hash : ""),
  fromDb: (raw) => new PasswordValue(toStr(raw)),
};
