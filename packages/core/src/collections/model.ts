export type CollectionType = "base" | "auth" | "view";

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

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  system: boolean;
  hidden: boolean;
  presentable: boolean;
  [option: string]: unknown;
}

export interface Collection {
  id: string;
  name: string;
  type: CollectionType;
  system: boolean;
  fields: Field[];
  indexes: string[];
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  [authOption: string]: unknown;
  created: string;
  updated: string;
}

export function crc32(value: string): string {
  return String(Bun.hash.crc32(value));
}

export function collectionId(type: string, name: string): string {
  return "hbc_" + crc32(type + name);
}

// the Heybe form of a PocketBase collection id: pbc_<n> and _pb_<name>_ become hbc_<n> and _hb_<name>_
export function fromPbCollectionId(id: string): string {
  return id.replace(/^pbc_/, "hbc_").replace(/^_pb_(.+_)$/, "_hb_$1");
}

export function fieldId(type: FieldType, name: string): string {
  return type + crc32(name);
}
