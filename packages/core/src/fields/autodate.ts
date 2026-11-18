import { sqlType } from "../collections/ddl";
import { date, normalizeDate } from "./date";
import type { FieldDef } from "./shared";

export const autodate: FieldDef = {
  sqlType: sqlType("autodate"),
  normalize: normalizeDate,
  validate: () => null,
  toDb: date.toDb,
  fromDb: date.fromDb,
};
