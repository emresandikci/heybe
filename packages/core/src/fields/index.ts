import type { FieldType } from "../collections/model";
import { autodate } from "./autodate";
import { bool } from "./bool";
import { date } from "./date";
import { editor } from "./editor";
import { email } from "./email";
import { file } from "./file";
import { geoPoint } from "./geo-point";
import { json } from "./json";
import { number } from "./number";
import { password } from "./password";
import { relation } from "./relation";
import { select } from "./select";
import type { FieldDef } from "./shared";
import { text } from "./text";
import { url } from "./url";

export type { FieldType } from "../collections/model";
export type { FieldCtx, FieldDef, FieldError } from "./shared";
export { PasswordValue } from "./password";

export const fields: Record<FieldType, FieldDef> = {
  text,
  number,
  bool,
  email,
  url,
  date,
  autodate,
  select,
  json,
  relation,
  file,
  password,
  editor,
  geoPoint,
};
