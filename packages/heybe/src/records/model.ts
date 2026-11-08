import type { Collection } from "../collections/model";
import { applyModifier, modifier, zeroValues } from "./service";
import { plain, sortKeys } from "./serialize";

type Values = Record<string, unknown>;
export type Expand = Record<string, RecordModel | RecordModel[]>;

const INTERNAL_PREFIX = "@pbInternal";

export class RecordModel {
  readonly collection: Collection;
  private readonly originalValues: Values;
  private readonly data = new Map<string, unknown>();
  private readonly visibility = new Map<string, boolean>();
  private fresh: boolean;
  private customData = false;
  private emailVisible = false;
  private expanded: Expand | null = null;

  constructor(collection: Collection, data: Values = {}, isNew = true) {
    this.collection = collection;
    this.fresh = isNew;
    this.originalValues = isNew ? zeroValues(collection) : { ...data };
    if (isNew) this.load(data);
  }

  get id(): string {
    return String(this.get("id") ?? "");
  }

  get(key: string): unknown {
    return this.data.has(key) ? this.data.get(key) : this.originalValues[key];
  }

  set(key: string, value: unknown): void {
    const f = this.collection.fields.find((f) => modifier(f, key));
    const op = f && modifier(f, key);
    if (!f || !op) this.data.set(key, value);
    else if (f.type !== "autodate")
      this.data.set(f.name, applyModifier(f, op, this.get(f.name), value));
  }

  // stores the value as is, without modifiers or normalization
  setRaw(key: string, value: unknown): void {
    this.data.set(key, value);
  }

  load(data: Values): void {
    for (const [key, value] of Object.entries(data)) this.set(key, value);
  }

  original(): RecordModel {
    return new RecordModel(this.collection, this.originalValues, false);
  }

  isNew(): boolean {
    return this.fresh;
  }

  markAsNew(): void {
    this.fresh = true;
  }

  markAsNotNew(): void {
    this.fresh = false;
  }

  expand(): Expand {
    return { ...this.expanded };
  }

  setExpand(expand: Expand): void {
    this.expanded = { ...expand };
  }

  hide(...fields: string[]): void {
    for (const name of fields) this.visibility.set(name, false);
  }

  unhide(...fields: string[]): void {
    for (const name of fields) this.visibility.set(name, true);
  }

  withCustomData(on: boolean): void {
    this.customData = on;
  }

  ignoreEmailVisibility(on: boolean): void {
    this.emailVisible = on;
  }

  toJSON(): Values {
    const c = this.collection;
    const visible = (name: string, byDefault: boolean) =>
      this.visibility.get(name) ?? byDefault;
    const out: Values = {};
    for (const f of c.fields) {
      if (f.type === "password" && c.type === "auth") continue;
      if (!visible(f.name, !f.hidden)) continue;
      const value = this.get(f.name);
      out[f.name] = f.type === "password" ? plain(value) : value;
    }
    if (this.customData) {
      const known = new Set(c.fields.map((f) => f.name));
      for (const [key, value] of this.data) {
        if (known.has(key) || key.startsWith(INTERNAL_PREFIX)) continue;
        if (visible(key, true)) out[key] = value;
      }
    }
    if (c.type === "auth") {
      delete out.tokenKey;
      if (!this.emailVisible && this.get("emailVisibility") !== true)
        delete out.email;
    }
    if (this.expanded && visible("expand", true)) {
      const expand: Values = {};
      for (const [key, rel] of Object.entries(this.expanded))
        expand[key] = Array.isArray(rel)
          ? rel.map((r) => r.toJSON())
          : rel.toJSON();
      out.expand = sortKeys(expand);
    }
    if (visible("collectionId", true)) out.collectionId = c.id;
    if (visible("collectionName", true)) out.collectionName = c.name;
    return sortKeys(out);
  }
}
