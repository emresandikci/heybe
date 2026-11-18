import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  listFromDb,
  listToDb,
  required,
  singleOrList,
  strings,
  uniqueStrings,
} from "./shared";

export const select: FieldDef = {
  sqlType: sqlType("select"),
  normalize: (value, field) => singleOrList(field, uniqueStrings(value)),
  validate(value, field) {
    const items = uniqueStrings(value);
    if (items.length === 0) return field.required === true ? required() : null;

    const maxSelect = Math.max(Number(field.maxSelect) || 0, 1);
    if (items.length > maxSelect)
      return fail(
        "validation_too_many_values",
        "Select no more than {{.maxSelect}}",
        { maxSelect },
      );

    const allowed = strings(field.values);
    const invalid = items.find((item) => !allowed.includes(item));
    if (invalid !== undefined)
      return fail("validation_invalid_value", "Invalid value {{.value}}", {
        value: invalid,
      });
    return null;
  },
  toDb: listToDb,
  fromDb: listFromDb,
};
