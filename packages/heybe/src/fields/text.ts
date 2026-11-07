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

const DEFAULT_LOWERCASE_ID_PATTERN = "^[a-z0-9]+$";
const FORBIDDEN_PK_CHARACTERS = [
  ".",
  "/",
  "\\",
  "|",
  '"',
  "'",
  "`",
  "<",
  ">",
  ":",
  "?",
  "*",
  "%",
  "$",
  "\0",
  "\t",
  "\n",
  "\r",
  " ",
];
const RESERVED_PKS = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`]),
];

export const text: FieldDef = {
  sqlType: sqlType("text"),
  normalize: (value) => toStr(value),
  validate(value, field, ctx) {
    if (typeof value !== "string") return unsupportedType();

    const isPk = field.primaryKey === true;
    const pattern = typeof field.pattern === "string" ? field.pattern : "";
    const customPkPattern = isPk && pattern !== DEFAULT_LOWERCASE_ID_PATTERN;

    if (isPk) {
      if (!ctx.isNew) {
        const old = ctx.original?.id;
        if (old !== value)
          return fail(
            "validation_pk_change",
            "The record primary key cannot be changed.",
          );
        if (old !== "" && old !== undefined) return null;
      } else if (customPkPattern) {
        const exists = ctx.db.get(
          `SELECT 1 FROM \`${ctx.collection.name}\` WHERE id = ? COLLATE NOCASE LIMIT 1`,
          [value],
        );
        if (exists)
          return fail(
            "validation_pk_invalid",
            "The record primary key is invalid or already exists.",
          );
      }
    }

    if (field.required === true || isPk) {
      if (value === "") return required();
    }
    if (value === "") return null;

    const length = runeLength(value);
    const min = Number(field.min) || 0;
    if (min > 0 && length < min)
      return fail(
        "validation_min_text_constraint",
        "Must be at least {{.min}} character(s).",
        { min },
      );

    const max = Number(field.max) || 5000;
    if (length > max)
      return fail(
        "validation_max_text_constraint",
        "Must be no more than {{.max}} character(s).",
        { max },
      );

    if (pattern !== "" && !validatePattern(pattern, value))
      return fail("validation_invalid_format", "Invalid value format.");

    if (customPkPattern) {
      for (const ch of FORBIDDEN_PK_CHARACTERS) {
        if (value.includes(ch))
          return fail(
            "validation_forbidden_pk_character",
            "'{{.ch}}' is not a valid primary key character.",
            { ch },
          );
      }
      const reserved = RESERVED_PKS.find(
        (r) => r.toLowerCase() === value.toLowerCase(),
      );
      if (reserved)
        return fail(
          "validation_reserved_pk",
          "The primary key '{{.reserved}}' is reserved and cannot be used.",
          { reserved },
        );
    }

    return null;
  },
  toDb: (value) => value,
  fromDb: (raw) => toStr(raw),
};
