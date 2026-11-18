import { quote, sqlType } from "../collections/ddl";
import {
  type FieldDef,
  fail,
  listFromDb,
  listToDb,
  required,
  singleOrList,
  uniqueStrings,
} from "./shared";

export const relation: FieldDef = {
  sqlType: sqlType("relation"),
  normalize: (value, field) => singleOrList(field, uniqueStrings(value)),
  validate(value, field, ctx) {
    const ids = uniqueStrings(value);
    if (ids.length === 0) return field.required === true ? required() : null;

    const minSelect = Number(field.minSelect) || 0;
    if (minSelect > 0 && ids.length < minSelect)
      return fail(
        "validation_not_enough_values",
        "Select at least {{.minSelect}}",
        { minSelect },
      );

    const maxSelect = Math.max(Number(field.maxSelect) || 0, 1);
    if (ids.length > maxSelect)
      return fail(
        "validation_too_many_values",
        "Select no more than {{.maxSelect}}",
        { maxSelect },
      );

    const target = ctx.findCollection(String(field.collectionId ?? ""));
    if (!target)
      return fail(
        "validation_missing_rel_collection",
        "Relation connection is missing or cannot be accessed",
      );

    const row = ctx.db.get<{ total: number }>(
      `SELECT count(*) AS total FROM ${quote(target.name)} WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    if (row?.total !== ids.length)
      return fail(
        "validation_missing_rel_records",
        "Failed to find all relation records with the provided ids",
      );
    return null;
  },
  toDb: listToDb,
  fromDb: listFromDb,
};
