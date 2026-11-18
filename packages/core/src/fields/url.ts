import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  required,
  strings,
  toStr,
  unsupportedType,
} from "./shared";

const URL_PATTERN = new RegExp(
  String.raw`^(?:(?:ftp|tcp|udp|wss?|https?)://)?(?:\S+(?::\S*)?@)?(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|(?:[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?\.)+\p{L}{2,})\.?(?::\d{1,5})?(?:[/?#]\S*)?$`,
  "iu",
);

export const isUrl = (value: string) =>
  value.length < 2083 && !value.startsWith(".") && URL_PATTERN.test(value);

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export const url: FieldDef = {
  sqlType: sqlType("url"),
  normalize: toStr,
  validate(value, field) {
    if (typeof value !== "string") return unsupportedType();
    if (field.required === true && value === "") return required();
    if (value === "") return null;
    if (!isUrl(value))
      return fail("validation_invalid_url", "Must be a valid url");

    const host = hostOf(value);
    const only = strings(field.onlyDomains);
    const except = strings(field.exceptDomains);
    if ((only.length > 0 && !only.includes(host)) || except.includes(host)) {
      return fail(
        "validation_url_domain_not_allowed",
        "Url domain is not allowed",
      );
    }
    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => toStr(raw),
};
