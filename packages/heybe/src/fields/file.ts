import { sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  isMultiple,
  listFromDb,
  listToDb,
  required,
  singleOrList,
  uniqueStrings,
} from "./shared";

export const file: FieldDef = {
  sqlType: sqlType("file"),
  normalize: (value, field) => singleOrList(field, uniqueStrings(value)),
  validate(value, field, ctx) {
    const files = uniqueStrings(value);
    if (files.length === 0) return field.required === true ? required() : null;

    const existing = uniqueStrings(ctx.original?.[field.name]);
    const added = files.filter((name) => !existing.includes(name));
    if (added.length > 0) {
      return fail(
        "validation_invalid_file",
        "Invalid new files: {{.invalidFiles}}.",
        {
          invalidFiles: added.map((name) => name.slice(0, 250)),
        },
      );
    }

    const maxSelect = isMultiple(field) ? Number(field.maxSelect) : 1;
    if (files.length > maxSelect)
      return fail(
        "validation_too_many_files",
        "The maximum allowed files is {{.maxSelect}}",
        { maxSelect },
      );
    return null;
  },
  toDb: listToDb,
  fromDb: listFromDb,
};
