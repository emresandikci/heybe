import { parseDate } from "../fields/date";
import { randomByPattern } from "../records/pattern";
import { formatDate } from "../util";
import {
  type Errors,
  type FieldErr,
  atLeast,
  atMost,
  err,
  firstError,
  invalidFormat,
  lengthRule,
  minRule,
  mustBeBlank,
  required,
} from "./errors";
import { type Collection, type Field, type FieldType, fieldId } from "./model";

export class DecodeError extends Error {}

export type Shape = { [key: string]: Kind | Shape };
type Kind =
  | "string"
  | "bool"
  | "int"
  | "float?"
  | "string?"
  | "strings"
  | "date"
  | "bool?"
  | "map"
  | "providers";

export const PROVIDER_SHAPE: Shape = {
  pkce: "bool?",
  name: "string",
  clientId: "string",
  clientSecret: "string",
  authURL: "string",
  tokenURL: "string",
  userInfoURL: "string",
  displayName: "string",
  extra: "map",
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

export function zero(shape: Shape): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(shape)) {
    if (typeof kind === "object") out[key] = zero(kind);
    else if (kind === "bool") out[key] = false;
    else if (kind === "int") out[key] = 0;
    else if (kind === "float?" || kind === "string?" || kind === "bool?")
      out[key] = null;
    else if (kind === "map") out[key] = {};
    else if (kind === "strings" || kind === "providers") out[key] = [];
    else out[key] = "";
  }
  return out;
}

function decodeDate(value: string): string {
  if (value === "") return "";
  const date = parseDate(value);
  return date ? formatDate(date) : "";
}

function decodeValue(kind: Kind, value: unknown): unknown {
  switch (kind) {
    case "string":
      if (typeof value !== "string") throw new DecodeError("string");
      return value;
    case "bool":
      if (typeof value !== "boolean") throw new DecodeError("bool");
      return value;
    case "int":
      if (!Number.isInteger(value)) throw new DecodeError("int");
      return value;
    case "float?":
      if (typeof value !== "number") throw new DecodeError("number");
      return value;
    case "string?":
      if (typeof value !== "string") throw new DecodeError("string");
      return value;
    case "strings":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
        throw new DecodeError("strings");
      return [...value];
    case "date":
      if (typeof value !== "string") throw new DecodeError("date");
      return decodeDate(value);
    case "bool?":
      if (typeof value !== "boolean") throw new DecodeError("bool");
      return value;
    case "map":
      if (!isObject(value)) throw new DecodeError("map");
      return structuredClone(value);
    case "providers":
      throw new DecodeError("providers");
  }
}

// Like PB's OAuth2Config.UnmarshalJSON: a submitted provider is merged on top of the existing one with the same name.
function decodeProviders(current: unknown, value: unknown) {
  if (!Array.isArray(value) || !value.every(isObject))
    throw new DecodeError("providers");
  const existing = (current as Record<string, unknown>[]) ?? [];
  return value.map((item) => {
    const original = existing.find((p) => p.name === item.name);
    const provider = original
      ? structuredClone(original)
      : zero(PROVIDER_SHAPE);
    decode(provider, item, PROVIDER_SHAPE);
    return provider;
  });
}

// Merges the keys present in `input` into `target`, like unmarshaling JSON on top of an existing struct.
export function decode(
  target: Record<string, unknown>,
  input: Record<string, unknown>,
  shape: Shape,
): void {
  for (const [key, kind] of Object.entries(shape)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (typeof kind === "object") {
      if (value === null) target[key] = zero(kind);
      else if (isObject(value))
        decode(
          (target[key] ??= zero(kind)) as Record<string, unknown>,
          value,
          kind,
        );
      else throw new DecodeError("object");
    } else if (value === null) {
      target[key] = zero({ v: kind }).v;
    } else if (kind === "providers") {
      target[key] = decodeProviders(target[key], value);
    } else {
      target[key] = decodeValue(kind, value);
    }
  }
}

const COMMON: Shape = {
  id: "string",
  name: "string",
  system: "bool",
  hidden: "bool",
  presentable: "bool",
};
const WITH_HELP: Shape = { ...COMMON, help: "string" };
const WITH_REQUIRED: Shape = { ...WITH_HELP, required: "bool" };
const DOMAINS: Shape = {
  ...WITH_REQUIRED,
  exceptDomains: "strings",
  onlyDomains: "strings",
};

export const FIELD_SHAPES: Record<FieldType, Shape> = {
  text: {
    ...WITH_REQUIRED,
    autogeneratePattern: "string",
    max: "int",
    min: "int",
    pattern: "string",
    primaryKey: "bool",
  },
  number: { ...WITH_REQUIRED, max: "float?", min: "float?", onlyInt: "bool" },
  bool: WITH_REQUIRED,
  email: DOMAINS,
  url: DOMAINS,
  date: { ...WITH_REQUIRED, max: "date", min: "date" },
  autodate: { ...COMMON, onCreate: "bool", onUpdate: "bool" },
  select: { ...WITH_REQUIRED, maxSelect: "int", values: "strings" },
  json: { ...WITH_REQUIRED, maxSize: "int" },
  relation: {
    ...WITH_REQUIRED,
    cascadeDelete: "bool",
    collectionId: "string",
    maxSelect: "int",
    minSelect: "int",
  },
  file: {
    ...WITH_REQUIRED,
    maxSelect: "int",
    maxSize: "int",
    mimeTypes: "strings",
    protected: "bool",
    thumbs: "strings",
  },
  editor: { ...WITH_REQUIRED, maxSize: "int", convertURLs: "bool" },
  geoPoint: WITH_REQUIRED,
  password: {
    ...WITH_REQUIRED,
    cost: "int",
    max: "int",
    min: "int",
    pattern: "string",
  },
};

const isFieldType = (type: unknown): type is FieldType =>
  typeof type === "string" && Object.hasOwn(FIELD_SHAPES, type);

export function fieldDefaults(type: FieldType): Record<string, unknown> {
  return { ...zero(FIELD_SHAPES[type]), type };
}

export function decodeField(raw: unknown): Field {
  if (!isObject(raw) || !isFieldType(raw.type)) throw new DecodeError("field");
  const field = fieldDefaults(raw.type);
  decode(field, raw, FIELD_SHAPES[raw.type]);
  return field as Field;
}

export function decodeFields(raw: unknown): Field[] {
  if (!Array.isArray(raw)) throw new DecodeError("fields");
  return addFields([], raw.map(decodeField));
}

// Same replace-or-append and default id rules as PB FieldsList.Add.
export function addFields(list: Field[], fields: Field[]): Field[] {
  const out = [...list];
  for (const f of fields) {
    let replaceByName = false;
    if (!f.id) {
      replaceByName = true;
      const root = fieldId(f.type, f.name);
      let id = root;
      for (let i = 2; i < 1000 && out.some((x) => x.id === id); i++)
        id = root + i;
      f.id = id;
    }
    const at = out.findIndex((x) =>
      replaceByName ? f.name !== "" && x.name === f.name : x.id === f.id,
    );
    if (at >= 0) {
      if (replaceByName) f.id = out[at]!.id;
      out[at] = f;
    } else out.push(f);
  }
  return out;
}

export function withDefaults(fields: Partial<Field>[]): Field[] {
  return addFields(
    [],
    fields.map(
      (f) => ({ ...fieldDefaults(f.type as FieldType), ...f }) as Field,
    ),
  );
}

const NAME_PATTERN = /^\w+$/;
const RESERVED_FIELD_NAMES = [
  "null",
  "true",
  "false",
  "_rowid_",
  "collectionId",
  "collectionName",
  "expand",
];

export function checkFieldName(name: unknown): FieldErr | null {
  if (typeof name !== "string" || name === "") return err(required);
  if ([...name].length > 100) return lengthRule(1, 100);
  if (!NAME_PATTERN.test(name)) return err(invalidFormat);
  if (RESERVED_FIELD_NAMES.includes(name))
    return err(["validation_not_in_invalid", "Must not be in list."]);
  if (name.toLowerCase().includes("_via_"))
    return err(["validation_found_via", 'The value cannot contain "_via_".']);
  return null;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const THUMB = /^\d+x\d+(t|b|f)?$/;
const DOMAIN =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-zA-Z]{1,63}| xn--[a-z0-9]{1,59})$/;

function checkAutogeneratePattern(f: Field): FieldErr | null {
  const pattern = String(f.autogeneratePattern ?? "");
  if (pattern === "") return null;
  const min = num(f.min);
  const max = num(f.max) || 5000;
  for (let i = 0; i < 10; i++) {
    let generated: string;
    try {
      generated = randomByPattern(pattern);
    } catch (e) {
      return err([
        "validation_invalid_autogenerate_pattern",
        (e as Error).message,
      ]);
    }
    const length = Array.from(generated).length;
    const invalid =
      ((f.required === true || f.primaryKey === true) && generated === "") ||
      (generated !== "" &&
        ((min > 0 && length < min) ||
          length > max ||
          (f.pattern !== "" &&
            !new RegExp(String(f.pattern)).test(generated))));
    if (invalid)
      return err([
        "validation_invalid_autogenerate_pattern_value",
        `The provided autogenerate pattern could produce invalid field values, ex.: ${JSON.stringify(generated)}`,
      ]);
  }
  return null;
}

function regexError(pattern: string): FieldErr | null {
  if (pattern === "") return null;
  try {
    new RegExp(pattern);
    return null;
  } catch {
    const open = (pattern.match(/\(/g) ?? []).length;
    const close = (pattern.match(/\)/g) ?? []).length;
    const reason =
      open > close
        ? "missing closing ): `" + pattern + "`"
        : close > open
          ? "unexpected ): `" + pattern + "`"
          : /\[/.test(pattern)
            ? "missing closing ]: `" + pattern + "`"
            : "invalid or unsupported Perl syntax: `" + pattern + "`";
    return err([
      "validation_invalid_regex",
      `Error parsing regexp: ${reason}.`,
    ]);
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

function eachItem(
  items: unknown,
  check: (item: string) => FieldErr | null,
): Errors | null {
  const out: Errors = {};
  (items as string[]).forEach((item, i) => {
    const e = check(item);
    if (e) out[i] = e;
  });
  return Object.keys(out).length > 0 ? out : null;
}

function domainChecks(f: Field): Errors {
  const only = f.onlyDomains as string[];
  const except = f.exceptDomains as string[];
  const out: Errors = {};
  if (only.length > 0 && except.length > 0) {
    out.exceptDomains = err(mustBeBlank);
    out.onlyDomains = err(mustBeBlank);
    return out;
  }
  const valid = (d: string) =>
    d === "" || (d.length <= 255 && DOMAIN.test(d))
      ? null
      : err(["validation_is_domain", "Must be a valid domain."]);
  const exceptErrors = eachItem(except, valid);
  const onlyErrors = eachItem(only, valid);
  if (exceptErrors) out.exceptDomains = exceptErrors;
  if (onlyErrors) out.onlyDomains = onlyErrors;
  return out;
}

export interface SettingsCtx {
  collection: Collection;
  find: (idOrName: string) => Collection | null;
  oldField?: Field;
}

export function validateFieldSettings(f: Field, ctx: SettingsCtx): Errors {
  const out: Errors = {};
  const set = (key: string, e: FieldErr | Errors | null) => {
    if (e) out[key] = e;
  };

  set("id", [...f.id].length > 100 ? lengthRule(1, 100) : null);
  if (f.id === "") set("id", err(required));
  const pk = f.type === "text" && f.primaryKey === true;
  set(
    "name",
    firstError(
      checkFieldName(f.name),
      pk && f.name !== "id"
        ? err(["validation_in_invalid", 'The primary key must be named "id".'])
        : null,
    ),
  );
  if (typeof f.help === "string" && [...f.help].length > 300)
    set("help", lengthRule(1, 300));

  switch (f.type) {
    case "text": {
      const min = num(f.min);
      const max = num(f.max);
      const pks = ctx.collection.fields.filter(
        (x) => x.type === "text" && x.primaryKey === true,
      ).length;
      set(
        "primaryKey",
        pk && pks > 1
          ? err([
              "validation_unsupported_composite_pk",
              "Composite PKs are not supported and the collection must have only 1 PK.",
            ])
          : null,
      );
      set("min", firstError(atLeast(min, 0), atMost(min, MAX_SAFE)));
      set("max", firstError(atLeast(max, min), atMost(max, MAX_SAFE)));
      set(
        "pattern",
        pk && f.pattern === "" ? err(required) : regexError(String(f.pattern)),
      );
      set("hidden", pk && f.hidden === true ? err(mustBeBlank) : null);
      set("required", pk && f.required !== true ? err(required) : null);
      set(
        "autogeneratePattern",
        firstError(
          regexError(String(f.autogeneratePattern)),
          checkAutogeneratePattern(f),
        ),
      );
      break;
    }
    case "number": {
      const min = f.min as number | null;
      const max = f.max as number | null;
      const onlyInt = (v: number | null) =>
        v !== null && f.onlyInt === true && !Number.isInteger(v)
          ? err([
              "validation_only_int_constraint",
              "Decimal numbers are not allowed.",
            ])
          : null;
      set("min", onlyInt(min));
      set(
        "max",
        firstError(
          onlyInt(max),
          min !== null && max !== null && max < min
            ? err(
                [
                  "validation_min_number_constraint",
                  `Must be greater or equal than ${min}.`,
                ],
                { min },
              )
            : null,
        ),
      );
      break;
    }
    case "email":
    case "url":
      Object.assign(out, domainChecks(f));
      break;
    case "autodate": {
      const both = err([
        "validation_required",
        "Either onCreate or onUpdate must be enabled.",
      ]);
      if (f.onCreate !== true && f.onUpdate !== true) {
        out.onCreate = both;
        out.onUpdate = both;
      }
      break;
    }
    case "select": {
      const values = f.values as string[];
      const max = values.length || 1;
      set("values", values.length === 0 ? err(required) : null);
      const maxSelect = num(f.maxSelect);
      set("maxSelect", maxSelect < 0 ? minRule(0) : atMost(maxSelect, max));
      break;
    }
    case "json":
    case "editor":
      set(
        "maxSize",
        firstError(
          num(f.maxSize) < 0 ? minRule(0) : null,
          atMost(num(f.maxSize), MAX_SAFE),
        ),
      );
      break;
    case "relation": {
      const minSelect = num(f.minSelect);
      const maxSelect = num(f.maxSelect);
      set("collectionId", relationTarget(f, ctx));
      set("minSelect", minSelect < 0 ? minRule(0) : null);
      set(
        "maxSelect",
        firstError(
          minSelect > 0 && maxSelect === 0 ? err(required) : null,
          atLeast(maxSelect, minSelect),
        ),
      );
      break;
    }
    case "file": {
      for (const key of ["maxSelect", "maxSize"] as const) {
        const v = num(f[key]);
        set(key, firstError(v < 0 ? minRule(0) : null, atMost(v, MAX_SAFE)));
      }
      set(
        "thumbs",
        eachItem(f.thumbs, (t) =>
          ["0x0", "0x0t", "0x0b", "0x0f"].includes(t)
            ? err(["validation_not_in_invalid", "Must not be in list."])
            : THUMB.test(t)
              ? null
              : err(invalidFormat),
        ),
      );
      break;
    }
    case "password": {
      const min = num(f.min);
      const max = num(f.max);
      const cost = num(f.cost);
      set("min", firstError(atLeast(min, 1), atMost(min, 71)));
      set("max", firstError(atLeast(max, min), atMost(max, 71)));
      set("cost", firstError(atLeast(cost, 4), atMost(cost, 31)));
      set("pattern", regexError(String(f.pattern)));
      break;
    }
  }
  return out;
}

function relationTarget(f: Field, ctx: SettingsCtx): FieldErr | null {
  const id = String(f.collectionId);
  if (id === "") return err(required);
  const changed = ctx.oldField && ctx.oldField.collectionId !== id;
  if (changed)
    return err([
      "validation_field_relation_change",
      "The relation collection cannot be changed.",
    ]);
  const target = ctx.find(id);
  if (!target || target.id !== id)
    return err([
      "validation_field_relation_missing_collection",
      "The relation collection doesn't exist.",
    ]);
  if (ctx.collection.type !== "view" && target.type === "view")
    return err([
      "validation_relation_field_non_view_base_collection",
      "Only view collections are allowed to have relations to other views.",
    ]);
  return null;
}
