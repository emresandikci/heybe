import { findSingleColumnUniqueIndex, quote } from "../collections/ddl";
import type { Collection, Field } from "../collections/model";
import type { CollectionStore } from "../collections/store";
import { isMultiple, uniqueStrings } from "../fields/shared";
import type { RequestInfo } from "./compile";
import { FilterError } from "./parse";

export type NullFallback = "auto" | "disabled" | "enforced";

export interface Join {
  table: string;
  alias: string;
  on?: string;
}

export interface MultiMatch {
  target: string;
  from: string;
  fromAlias: string;
  value: string;
  joins: Join[];
}

// `id` is a SQL fragment where every value is a `{:key}` placeholder; `params` are the keys it carries.
export interface Resolved {
  id: string;
  params: string[];
  nullFallback: NullFallback;
  multi?: MultiMatch;
  after?: (sql: string) => string;
  changed?: string;
}

export interface ResolverCtx {
  collection: Collection;
  store: CollectionStore;
  request: RequestInfo | null;
}

const ALLOWED = [
  /^\w+[\w.:]*$/,
  /^@request\.context$/,
  /^@request\.method$/,
  /^@request\.auth\.[\w.:]*\w+$/,
  /^@request\.body\.[\w.:]*\w+$/,
  /^@request\.query\.[\w.:]*\w+$/,
  /^@request\.headers\.[\w.:]*\w+$/,
  /^@collection\.\w+(:\w+)?\.[\w.:]*\w+$/,
];

const PLAIN_AUTH_FIELDS = new Set(
  [
    "id",
    "collectionId",
    "collectionName",
    "email",
    "emailVisibility",
    "verified",
  ].map((f) => "@request.auth." + f),
);

const MODIFIERS = new Set(["isset", "each", "length", "lower", "changed"]);
const MULTI_VALUERS = new Set(["select", "relation", "file"]);
const MAX_NESTED_RELS = 6;

export const placeholder = (key: string) => `{:${key}}`;
export const col = (alias: string, name: string) =>
  `${quote(alias)}.${quote(name)}`;
export const plain = (id: string): Resolved => ({
  id,
  params: [],
  nullFallback: "auto",
});
const NULL = () => plain("NULL");

export const jsonEach = (c: string) =>
  `json_each(CASE WHEN iif(json_valid(${c}), json_type(${c})='array', FALSE) THEN ${c} ELSE json_array(${c}) END)`;

const jsonArrayLength = (c: string) =>
  `json_array_length(CASE WHEN iif(json_valid(${c}), json_type(${c})='array', FALSE) THEN ${c} ELSE (CASE WHEN ${c} = '' OR ${c} IS NULL THEN json_array() ELSE json_array(${c}) END) END)`;

function jsonExtract(c: string, path: string) {
  if (path !== "" && !path.startsWith("[")) path = "." + path;
  return `(CASE WHEN json_valid(${c}) THEN JSON_EXTRACT(${c}, '$${path}') ELSE JSON_EXTRACT(json_object('pb', ${c}), '$.pb${path}') END)`;
}

export const joinSql = (j: Join) =>
  `LEFT JOIN ${j.table} ${quote(j.alias)}${j.on ? ` ON ${j.on}` : ""}`;

export function multiMatchSql(m: MultiMatch): string {
  return `SELECT ${m.value} as \`multiMatchValue\` FROM ${quote(m.from)} ${quote(m.fromAlias)} ${m.joins.map(joinSql).join(" ")} WHERE ${col(m.fromAlias, "id")} = ${col(m.target, "id")}`;
}

const getField = (c: Collection, name: string): Field | undefined =>
  c.fields.find((f) => f.name === name);

function splitModifier(combined: string): [string, string] {
  const parts = combined.split(":");
  if (parts.length !== 2) return [combined, ""];
  if (!MODIFIERS.has(parts[1]!))
    throw new FilterError(`unknown modifier in "${combined}"`);
  return [parts[0]!, parts[1]!];
}

function extract(data: unknown, keys: string[]): { value: unknown } | null {
  let current = data;
  for (const key of keys) {
    if (Array.isArray(current)) {
      const i = /^[+-]?\d+$/.test(key) ? Number(key) : -1;
      if (i < 0 || i >= current.length) return null;
      current = current[i];
    } else if (
      current !== null &&
      typeof current === "object" &&
      Object.hasOwn(current, key)
    ) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return { value: current };
}

const toSlice = (value: unknown): unknown[] =>
  value === null || value === undefined
    ? []
    : Array.isArray(value)
      ? value
      : [value];

const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Port of RecordFieldResolver: holds the joins and the bound values of one query.
export class Resolver {
  allowHidden = true;
  readonly joins: Join[] = [];
  readonly ruleJoins: { collection: Collection; alias: string }[] = [];

  constructor(
    readonly ctx: ResolverCtx,
    readonly state = {
      values: new Map<string, unknown>(),
      integers: new Set<string>(),
      seq: 0,
    },
    readonly baseAlias = ctx.collection.name,
    readonly aliasSuffix = "",
  ) {}

  next(): number {
    return ++this.state.seq;
  }

  // PB binds numbers as float64, except the integer macros.
  param(value: unknown, integer = false): string {
    const key = `p${this.state.values.size}`;
    this.state.values.set(key, value);
    if (integer) this.state.integers.add(key);
    return key;
  }

  resolve(name: string): Resolved {
    return new Runner(this, name).run();
  }

  // Clone used to apply a joined collection's list rule on its join alias.
  ruleResolver(collection: Collection, alias: string): Resolver {
    return new Resolver(
      { ...this.ctx, collection },
      this.state,
      alias,
      `_r${this.next()}`,
    );
  }

  findCollection(nameOrId: string): Collection | null {
    const base = this.ctx.collection;
    if (nameOrId === base.name || nameOrId === base.id) return base;
    return this.ctx.store.find(nameOrId);
  }

  loadCollection(nameOrId: string, message: string): Collection {
    const c = this.findCollection(nameOrId);
    if (!c) throw new FilterError(message);
    return c;
  }

  registerJoin(
    table: string,
    alias: string,
    on?: string,
    collection?: Collection,
  ) {
    if (!this.allowHidden && collection) {
      if (collection.listRule === null) {
        throw new FilterError(
          `"${collection.name}" fields can be accessed only when allowHiddenFields is enabled or by superusers`,
        );
      }
      const rule = this.ruleJoins.find((j) => j.alias === alias);
      if (rule) rule.collection = collection;
      else this.ruleJoins.push({ collection, alias });
    }
    const join = { table, alias, on };
    const i = this.joins.findIndex((j) => j.alias === alias);
    if (i >= 0) this.joins[i] = join;
    else this.joins.push(join);
  }

  authCollection(): Collection | null {
    const req = this.ctx.request;
    return req?.auth && req.authCollection
      ? this.ctx.store.find(req.authCollection)
      : null;
  }

  staticField(path: string[]): Resolved {
    const [prop, modifier] = splitModifier(path[path.length - 1]!);
    const req = this.ctx.request!;
    const authCollection = this.authCollection();
    const info = {
      context: req.context,
      method: req.method,
      query: req.query,
      headers: req.headers,
      body: req.body,
      auth: req.auth && {
        ...req.auth,
        ...(authCollection && {
          collectionId: authCollection.id,
          collectionName: authCollection.name,
        }),
      },
    };
    const found = extract(info, [...path.slice(0, -1), prop]);

    if (modifier === "isset") return plain(found ? "TRUE" : "FALSE");

    let value = found?.value ?? null;
    if (typeof value === "string") {
      if (
        getField(this.ctx.collection, prop)?.type === "number" &&
        FLOAT.test(value)
      )
        value = Number(value);
    } else if (
      value !== null &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      value = JSON.stringify(value);
    }

    if (modifier !== "" && modifier !== "lower") {
      throw new FilterError(`invalid modifier sequence ${prop}:${modifier}`);
    }
    if (value === null) return NULL();

    const key = this.param(value);
    const id = placeholder(key);
    return {
      id: modifier === "lower" ? `LOWER(${id})` : id,
      params: [key],
      nullFallback: "auto",
    };
  }
}

// Port of the PB resolver runner: resolves a single field path.
class Runner {
  private props: string[];
  private collectionName: string;
  private alias: string;
  private readonly nullifyMissing: boolean;
  private withMulti = false;
  private readonly mm: MultiMatch;
  private mmAlias: string;

  constructor(
    private readonly r: Resolver,
    private readonly name: string,
  ) {
    this.props = name.split(".");
    this.collectionName = r.ctx.collection.name;
    this.alias = r.baseAlias;
    this.nullifyMissing = this.props[0] === "@request";
    this.mm = {
      target: this.alias,
      from: this.collectionName,
      fromAlias: "__mm_" + this.alias,
      value: "",
      joins: [],
    };
    this.mmAlias = this.mm.fromAlias;
  }

  run(): Resolved {
    if (!ALLOWED.some((re) => re.test(this.name))) {
      throw new FilterError(`failed to resolve field "${this.name}"`);
    }
    if (this.props[0] === "@collection") return this.collectionField();
    if (this.props[0] !== "@request") return this.activeProps();

    const req = this.r.ctx.request;
    if (!req) return NULL();
    if (this.name.startsWith("@request.auth.")) return this.authField();

    if (this.name.startsWith("@request.body.") && this.props.length > 2) {
      const [name, modifier] = splitModifier(this.props[2]!);
      const field = getField(this.r.ctx.collection, name);
      if (!field) return this.r.staticField(this.props.slice(1));
      if (field.type === "relation" && this.props.length > 3)
        return this.bodyRelation(field);
      if (this.props.length === 3) {
        if (modifier === "each") return this.bodyEach(field);
        if (modifier === "length") return this.bodyLength(field);
        if (modifier === "lower") return this.bodyLower(field);
        if (modifier === "changed") {
          return {
            id: `@changed@${field.name}@${this.r.next()}@`,
            params: [],
            nullFallback: "disabled",
            changed: field.name,
          };
        }
      }
    }
    return this.r.staticField(this.props.slice(1));
  }

  private collectionField(): Resolved {
    const [nameOrId, aliasName] = this.props[1]!.split(":");
    const collection = this.r.loadCollection(
      nameOrId!,
      `failed to load collection "${this.props[1]}" from field path "${this.name}"`,
    );
    this.collectionName = collection.name;
    this.alias =
      (aliasName
        ? "__collection_alias_" + aliasName
        : "__collection_" + collection.name) + this.r.aliasSuffix;
    this.withMulti = true;
    this.r.registerJoin(
      quote(collection.name),
      this.alias,
      undefined,
      collection,
    );
    this.mmAlias = "__mm_" + this.alias;
    this.mm.joins.push({ table: quote(collection.name), alias: this.mmAlias });
    this.props = this.props.slice(2);
    return this.activeProps();
  }

  private authField(): Resolved {
    const collection = this.r.authCollection();
    if (!collection) return NULL();
    if (PLAIN_AUTH_FIELDS.has(this.name))
      return this.r.staticField(this.props.slice(1));

    const authId = placeholder(this.r.param(this.r.ctx.request!.auth!.id));
    this.collectionName = collection.name;
    this.alias = "__auth_" + collection.name + this.r.aliasSuffix;
    this.r.registerJoin(
      quote(collection.name),
      this.alias,
      `${col(this.alias, "id")} = ${authId}`,
      collection,
    );
    this.mmAlias = "__mm_" + this.alias;
    this.mm.joins.push({
      table: quote(collection.name),
      alias: this.mmAlias,
      on: `${col(this.mmAlias, "id")} = ${authId}`,
    });
    this.props = this.props.slice(2);
    return this.activeProps();
  }

  private body(field: Field): unknown {
    return this.r.ctx.request!.body[field.name];
  }

  private requireMultiValuer(field: Field) {
    if (!MULTI_VALUERS.has(field.type)) {
      throw new FilterError(
        `field "${field.name}" doesn't support multivalue operations`,
      );
    }
  }

  private bodyEach(field: Field): Resolved {
    this.requireMultiValuer(field);
    const raw = JSON.stringify(toSlice(this.body(field)));
    const key = this.r.param(raw);
    const jeAlias = "__dataEach_je_" + field.name + this.r.aliasSuffix;
    this.r.registerJoin(`json_each(${placeholder(key)})`, jeAlias);

    const result: Resolved = {
      id: col(jeAlias, "value"),
      params: [key],
      nullFallback: "auto",
    };
    if (isMultiple(field)) this.withMulti = true;
    if (this.withMulti) {
      const jeAlias2 = "__mm_" + jeAlias;
      this.mm.joins.push({
        table: `json_each(${placeholder(this.r.param(raw))})`,
        alias: jeAlias2,
      });
      this.mm.value = col(jeAlias2, "value");
      result.multi = this.mm;
    }
    return result;
  }

  private bodyLength(field: Field): Resolved {
    this.requireMultiValuer(field);
    return plain(String(toSlice(this.body(field)).length));
  }

  private bodyLower(field: Field): Resolved {
    const value = this.body(field);
    const raw =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : "";
    const key = this.r.param(raw);
    return {
      id: `LOWER(${placeholder(key)})`,
      params: [key],
      nullFallback: "auto",
    };
  }

  private bodyRelation(field: Field): Resolved {
    const relCollection = this.r.loadCollection(
      String(field.collectionId ?? ""),
      `failed to load collection "${field.collectionId}" from data field "${field.name}"`,
    );
    const ids = uniqueStrings(this.body(field));
    if (ids.length === 0) return NULL();

    const list = ids.map((id) => placeholder(this.r.param(id))).join(", ");
    this.collectionName = relCollection.name;
    this.alias =
      "__data_" + relCollection.name + "_" + field.name + this.r.aliasSuffix;
    this.r.registerJoin(
      quote(relCollection.name),
      this.alias,
      `${col(this.alias, "id")} IN (${list})`,
      relCollection,
    );
    if (isMultiple(field)) this.withMulti = true;
    this.mmAlias = "__mm_" + this.alias;
    this.mm.joins.push({
      table: quote(relCollection.name),
      alias: this.mmAlias,
      on: `${col(this.mmAlias, "id")} IN (${list})`,
    });
    this.props = this.props.slice(3);
    return this.activeProps();
  }

  private missing(message: string): Resolved {
    if (this.nullifyMissing) return NULL();
    throw new FilterError(message);
  }

  private activeProps(): Resolved {
    const total = this.props.length;
    for (let i = 0; i < total; i++) {
      const prop = this.props[i]!;
      const collection = this.r.loadCollection(
        this.collectionName,
        `failed to resolve field "${prop}"`,
      );
      if (i === total - 1) return this.finalize(collection, prop);

      const field = getField(collection, prop);
      if (field?.hidden && !this.r.allowHidden)
        throw new FilterError(`non-filterable field "${prop}"`);

      if (field?.type === "json") return this.jsonPath(field, i);

      if (i >= MAX_NESTED_RELS)
        throw new FilterError(
          `max nested relations reached for field "${prop}"`,
        );

      if (!field) {
        const back = this.backRelation(collection, prop);
        if (back) return back;
        continue;
      }

      if (field.type !== "relation")
        throw new FilterError(`field "${prop}" is not a valid relation`);
      const relCollection = this.r.loadCollection(
        String(field.collectionId ?? ""),
        `failed to load field "${prop}" collection`,
      );
      const multiple = isMultiple(field);

      // "user.id" resolves to the "user" column without a join
      if (!multiple && i === total - 2 && this.props[i + 1] === "id")
        return this.finalize(collection, field.name);

      const newAlias = this.alias + "_" + field.name + this.r.aliasSuffix;
      if (!multiple) {
        this.r.registerJoin(
          quote(relCollection.name),
          newAlias,
          `${col(newAlias, "id")} = ${col(this.alias, field.name)}`,
          relCollection,
        );
      } else {
        const jeAlias = "__je_" + newAlias;
        this.r.registerJoin(jsonEach(col(this.alias, field.name)), jeAlias);
        this.r.registerJoin(
          quote(relCollection.name),
          newAlias,
          `${col(newAlias, "id")} = ${col(jeAlias, "value")}`,
          relCollection,
        );
      }
      this.collectionName = relCollection.name;
      this.alias = newAlias;

      if (multiple) this.withMulti = true;
      const newAlias2 = this.mmAlias + "_" + field.name;
      if (!multiple) {
        this.mm.joins.push({
          table: quote(relCollection.name),
          alias: newAlias2,
          on: `${col(newAlias2, "id")} = ${col(this.mmAlias, field.name)}`,
        });
      } else {
        const jeAlias2 = this.mmAlias + "_" + field.name + "_je";
        this.mm.joins.push(
          { table: jsonEach(col(this.mmAlias, field.name)), alias: jeAlias2 },
          {
            table: quote(relCollection.name),
            alias: newAlias2,
            on: `${col(newAlias2, "id")} = ${col(jeAlias2, "value")}`,
          },
        );
      }
      this.mmAlias = newAlias2;
    }
    throw new FilterError(`failed to resolve field "${this.name}"`);
  }

  // The remaining props are a json path inside the field.
  private jsonPath(field: Field, i: number): Resolved {
    let path = "";
    this.props.slice(i + 1).forEach((p, j) => {
      const clean = p.replace(/\W/g, "");
      if (/^[+-]?\d+$/.test(p)) path += `[${clean}]`;
      else path += (j > 0 ? "." : "") + clean;
    });
    const result: Resolved = {
      id: jsonExtract(col(this.alias, field.name), path),
      params: [],
      nullFallback: "disabled",
    };
    if (this.withMulti) {
      this.mm.value = jsonExtract(col(this.mmAlias, field.name), path);
      result.multi = this.mm;
    }
    return result;
  }

  // Handles "<collection>_via_<relField>". Returns a result only when the path ends as NULL.
  private backRelation(collection: Collection, prop: string): Resolved | null {
    const match = /^(\w+)_via_(\w+)$/.exec(prop);
    if (!match) return this.missing(`failed to resolve field "${prop}"`);
    const back = this.r.findCollection(match[1]!);
    if (!back)
      return this.missing(
        `failed to load back relation field "${prop}" collection`,
      );
    const backField = getField(back, match[2]!);
    if (!backField)
      return this.missing(`missing back relation field "${match[2]}"`);
    if (backField.type !== "relation")
      return this.missing(`invalid back relation field "${match[2]}"`);
    if (backField.hidden && !this.r.allowHidden) {
      throw new FilterError(
        `non-filterable back relation field "${backField.name}"`,
      );
    }
    if (backField.collectionId !== collection.id) {
      return this.missing(
        `invalid collection reference of a back relation field "${backField.name}"`,
      );
    }

    const multiple = isMultiple(backField);
    const backColumn = backField.name;
    const newAlias = this.alias + "_" + prop + this.r.aliasSuffix;
    if (!multiple) {
      this.r.registerJoin(
        quote(back.name),
        newAlias,
        `${col(newAlias, backColumn)} = ${col(this.alias, "id")}`,
        back,
      );
    } else {
      const jeAlias = "__je_" + newAlias;
      this.r.registerJoin(
        quote(back.name),
        newAlias,
        `${col(this.alias, "id")} IN (SELECT ${col(jeAlias, "value")} FROM ${jsonEach(col(newAlias, backColumn))} ${quote(jeAlias)})`,
        back,
      );
    }
    this.collectionName = back.name;
    this.alias = newAlias;

    if (multiple) this.withMulti = true;
    else if (!this.withMulti)
      this.withMulti = !findSingleColumnUniqueIndex(back.indexes, backColumn);

    const newAlias2 = this.mmAlias + "_" + prop + this.r.aliasSuffix;
    if (!multiple) {
      this.mm.joins.push({
        table: quote(back.name),
        alias: newAlias2,
        on: `${col(newAlias2, backColumn)} = ${col(this.mmAlias, "id")}`,
      });
    } else {
      const jeAlias2 = "__je_" + newAlias2;
      this.mm.joins.push({
        table: quote(back.name),
        alias: newAlias2,
        on: `${col(this.mmAlias, "id")} IN (SELECT ${col(jeAlias2, "value")} FROM ${jsonEach(col(newAlias2, backColumn))} ${quote(jeAlias2)})`,
      });
    }
    this.mmAlias = newAlias2;
    return null;
  }

  private finalize(collection: Collection, prop: string): Resolved {
    const [name, modifier] = splitModifier(prop);
    const field = getField(collection, name);
    if (!field) return this.missing(`unknown field "${name}"`);
    if (field.hidden && !this.r.allowHidden)
      throw new FilterError(`non-filterable field "${name}"`);

    const multiValuer = MULTI_VALUERS.has(field.type);
    const column = col(this.alias, field.name);
    const column2 = col(this.mmAlias, field.name);

    if (modifier === "length" && multiValuer) {
      const result: Resolved = {
        id: jsonArrayLength(column),
        params: [],
        nullFallback: "auto",
      };
      if (this.withMulti) {
        this.mm.value = jsonArrayLength(column2);
        result.multi = this.mm;
      }
      return result;
    }

    if (modifier === "each" && multiValuer) {
      const jeAlias =
        "__je_" + this.alias + "_" + field.name + this.r.aliasSuffix;
      this.r.registerJoin(jsonEach(column), jeAlias);
      const result: Resolved = {
        id: col(jeAlias, "value"),
        params: [],
        nullFallback: "auto",
      };
      if (isMultiple(field)) this.withMulti = true;
      if (this.withMulti) {
        const jeAlias2 =
          "__je_" + this.mmAlias + "_" + field.name + this.r.aliasSuffix;
        this.mm.joins.push({ table: jsonEach(column2), alias: jeAlias2 });
        this.mm.value = col(jeAlias2, "value");
        result.multi = this.mm;
      }
      return result;
    }

    const result: Resolved = { id: column, params: [], nullFallback: "auto" };
    if (this.withMulti) {
      this.mm.value = column2;
      result.multi = this.mm;
    }

    // only auth emails marked as public are matched
    if (
      field.name === "email" &&
      !this.r.allowHidden &&
      collection.type === "auth"
    ) {
      const visibility = col(this.alias, "emailVisibility");
      result.after = (sql) => `(${sql} AND ${visibility} = TRUE)`;
    }

    // json_extract makes top-level json primitives compare like their SQL equivalent
    if (field.type === "json") {
      result.nullFallback = "disabled";
      result.id = jsonExtract(column, "");
      if (this.withMulti) this.mm.value = jsonExtract(column2, "");
    }

    if (modifier === "lower") {
      result.id = `LOWER(${result.id})`;
      if (this.withMulti) this.mm.value = `LOWER(${this.mm.value})`;
    }
    return result;
  }
}
