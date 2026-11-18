import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  required,
  toStr,
  unsupportedType,
} from "./shared";

const DEFAULT_MAX_SIZE = 5 << 20;
const encoder = new TextEncoder();

export const editor: FieldDef = {
  sqlType: sqlType("editor"),
  normalize: toStr,
  maxBodySize: (field) =>
    Number(field.maxSize) > 0 ? Number(field.maxSize) : DEFAULT_MAX_SIZE,
  validate(value, field) {
    if (typeof value !== "string") return unsupportedType();
    if (field.required === true && value === "") return required();
    const maxSize = editor.maxBodySize!(field);
    if (encoder.encode(value).length > maxSize)
      return fail(
        "validation_content_size_limit",
        "The maximum allowed content size is {{.maxSize}} bytes",
        { maxSize },
      );
    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => toStr(raw),
};
