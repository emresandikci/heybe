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
  // the plain text stays so validation still sees it; only the hash is stored
  async prepare(value, field) {
    const v = password.normalize(value, field) as PasswordValue;
    if (v.plain === "") return v;
    const cost = Number(field.cost) > 0 ? Number(field.cost) : DEFAULT_COST;
    return new PasswordValue(
      await Bun.password.hash(v.plain, { algorithm: "bcrypt", cost }),
      v.plain,
    );
  },
  validate(value, field) {
    if (!(value instanceof PasswordValue)) return unsupportedType();
    // PB's bcrypt hashing fails above 72 bytes and that error is reported first
    if (Buffer.byteLength(value.plain) > 72)
      return fail("validation_invalid_value", "Invalid value");
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
