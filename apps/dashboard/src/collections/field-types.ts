import type { FieldModel } from "./editor-state";

export type FieldType =
  | "text"
  | "number"
  | "bool"
  | "email"
  | "url"
  | "date"
  | "autodate"
  | "select"
  | "json"
  | "relation"
  | "file"
  | "password"
  | "editor"
  | "geoPoint";

let keys = 0;
export const nextKey = () => `f${++keys}`;

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: "text", label: "Plain text" },
  { type: "editor", label: "Rich editor" },
  { type: "number", label: "Number" },
  { type: "bool", label: "Bool" },
  { type: "email", label: "Email" },
  { type: "url", label: "URL" },
  { type: "date", label: "Date" },
  { type: "autodate", label: "Autodate" },
  { type: "select", label: "Select" },
  { type: "file", label: "File" },
  { type: "relation", label: "Relation" },
  { type: "json", label: "JSON" },
  { type: "geoPoint", label: "Geo point" },
  { type: "password", label: "Password" },
];

const domains = () => ({ exceptDomains: [], onlyDomains: [] });

const OPTIONS: Record<FieldType, () => Record<string, unknown>> = {
  text: () => ({
    autogeneratePattern: "",
    max: 0,
    min: 0,
    pattern: "",
    primaryKey: false,
  }),
  number: () => ({ max: null, min: null, onlyInt: false }),
  bool: () => ({}),
  email: domains,
  url: domains,
  date: () => ({ max: "", min: "" }),
  autodate: () => ({ onCreate: false, onUpdate: false }),
  select: () => ({ maxSelect: 0, values: [] }),
  json: () => ({ maxSize: 0 }),
  relation: () => ({
    cascadeDelete: false,
    collectionId: "",
    maxSelect: 0,
    minSelect: 0,
  }),
  file: () => ({
    maxSelect: 0,
    maxSize: 0,
    mimeTypes: [],
    protected: false,
    thumbs: [],
  }),
  editor: () => ({ maxSize: 0, convertURLs: false }),
  geoPoint: () => ({}),
  password: () => ({ cost: 0, max: 0, min: 0, pattern: "" }),
};

export function fieldTypeLabel(type: string): string {
  return FIELD_TYPES.find((t) => t.type === type)?.label ?? type;
}

export function fieldDefaults(type: FieldType): FieldModel {
  return {
    _key: nextKey(),
    name: "",
    type,
    system: false,
    hidden: false,
    presentable: false,
    ...(type === "autodate" ? {} : { help: "", required: false }),
    ...OPTIONS[type](),
  };
}
