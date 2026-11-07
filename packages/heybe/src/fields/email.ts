import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  required,
  strings,
  toStr,
  unsupportedType,
} from "./shared";

const ATOM = "[\\p{L}\\p{N}!#$%&'*+\\-/=?^_`{|}~]+";
const LOCAL = `${ATOM}(?:\\.${ATOM})*`;
const LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}\-.~]*[\p{L}\p{N}])?`;
const EMAIL = new RegExp(
  String.raw`^${LOCAL}@(?:${LABEL}\.)+\p{L}(?:[\p{L}\p{N}\-~]*\p{L})?\.?$`,
  "u",
);

export const email: FieldDef = {
  sqlType: sqlType("email"),
  normalize: toStr,
  validate(value, field) {
    if (typeof value !== "string") return unsupportedType();
    if (field.required === true && value === "") return required();
    if (value === "") return null;
    if (!EMAIL.test(value))
      return fail("validation_is_email", "must be a valid email address");

    const domain = value.slice(value.lastIndexOf("@") + 1);
    const only = strings(field.onlyDomains);
    const except = strings(field.exceptDomains);
    if (
      (only.length > 0 && !only.includes(domain)) ||
      except.includes(domain)
    ) {
      return fail(
        "validation_email_domain_not_allowed",
        "Email domain is not allowed",
      );
    }
    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => toStr(raw),
};
