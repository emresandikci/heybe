import type { App } from "../app";
import { findSingleColumnUniqueIndex, quote } from "../collections/ddl";
import type { Collection, Field } from "../collections/model";
import { isMultiple, uniqueStrings } from "../fields/shared";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { parseFilter } from "../filter/parse";
import { jsonEach } from "../filter/resolve";
import { logUnexpected } from "../http/errors";
import { serializeRecord, sortKeys } from "./serialize";
import { decode, isSuperuser, manageRuleOf, managedIds } from "./read";

type Values = Record<string, unknown>;
type ExpandApp = Pick<App, "db" | "collections" | "now">;
type Expanded = Map<string, Node | Node[]>;

interface Node {
  id: string;
  // relation ids are read from here
  values: Values;
  out: Values;
  expand?: Expanded;
}

interface Ctx {
  app: ExpandApp;
  request: RequestInfo | null;
  superuser: boolean;
}

const MAX_NESTED_RELS = 6;
const BACK_RELATION_LIMIT = 1000;
const BACK_RELATION = /^(\w+)_via_(\w+)$/;

// An expand path PB rejects: unknown relation or a collection the requester cannot view.
class PathError extends Error {}

// Port of PB ExpandRecords with the apis expandFetch: every expanded collection is filtered by its
// view rule for the requester (a null request is a superuser). `records` are serialized records.
export function expandRecords(
  app: ExpandApp,
  collection: Collection,
  records: Values[],
  paths: string[],
  request: RequestInfo | null,
): Values[] {
  const normalized = normalizeExpands(paths);
  if (records.length === 0 || normalized.length === 0) return records;
  const ctx: Ctx = {
    app,
    request: request && { ...request, context: "expand" },
    superuser: request === null || isSuperuser(request),
  };
  const nodes = records.map((r) => ({ id: String(r.id), values: r, out: r }));
  loadHiddenRelations(app, collection, nodes);
  for (const path of normalized) {
    try {
      expandLevel(ctx, collection, nodes, path, 1);
    } catch (err) {
      // like PB, a failed path is left out; rule errors are FilterErrors, also not logged
      if (!(err instanceof PathError)) logUnexpected(err);
    }
  }
  return nodes.map(toJson);
}

// Port of PB normalizeExpands: drops spaces and incomplete paths, keeps only the longest of nested paths.
function normalizeExpands(paths: string[]): string[] {
  const normalized = paths
    .map((p) => p.replaceAll(" ", "").replace(/^\.+|\.+$/g, ""))
    .filter((p) => p !== "");
  const longest = normalized.filter(
    (p, i) => !normalized.some((q, j) => i !== j && q.startsWith(p + ".")),
  );
  return [...new Set(longest)];
}

// Serialized records lack hidden fields, but PB expands hidden relation fields too.
function loadHiddenRelations(app: ExpandApp, c: Collection, nodes: Node[]) {
  const hidden = c.fields.filter((f) => f.type === "relation" && f.hidden);
  const missing = nodes.filter((n) =>
    hidden.some((f) => !(f.name in n.values)),
  );
  if (missing.length === 0) return;
  const rows = app.db.query<Values>(
    `SELECT * FROM ${quote(c.name)} WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(missing.map((n) => n.id))],
  );
  const byId = new Map(rows.map((r) => [r.id as string, decode(c, r)]));
  for (const n of missing) n.values = { ...byId.get(n.id), ...n.values };
}

function expandLevel(
  ctx: Ctx,
  c: Collection,
  nodes: Node[],
  path: string,
  level: number,
): void {
  if (path === "" || level > MAX_NESTED_RELS || nodes.length === 0) return;
  const dot = path.indexOf(".");
  const name = dot < 0 ? path : path.slice(0, dot);
  const { target, multiple, idsOf } = relation(ctx.app, c, nodes, name);
  const rels = fetch(ctx, target, [...new Set(nodes.flatMap(idsOf))]);
  if (dot >= 0) expandLevel(ctx, target, rels, path.slice(dot + 1), level + 1);

  const byId = new Map(rels.map((r) => [r.id, r]));
  for (const node of nodes) {
    // set even when empty, so the response still has the "expand" key
    node.expand ??= new Map();
    const valid = idsOf(node).flatMap((id) => byId.get(id) ?? []);
    if (valid.length === 0) continue;
    for (const old of asList(node.expand.get(name))) {
      for (const rel of valid)
        if (rel.id === old.id) mergeExpand(rel, old.expand);
    }
    node.expand.set(name, multiple ? valid : valid[0]!);
  }
}

function relation(
  app: ExpandApp,
  c: Collection,
  nodes: Node[],
  name: string,
): { target: Collection; multiple: boolean; idsOf: (n: Node) => string[] } {
  const back = BACK_RELATION.exec(name);
  if (back) {
    const from = app.collections.find(back[1]!);
    const field = from?.fields.find((f) => f.name === back[2]);
    if (!from || field?.type !== "relation" || field.collectionId !== c.id)
      throw new PathError(`invalid back-relation "${name}"`);
    const ids = backRelationIds(app, from, field, nodes);
    return {
      target: from,
      multiple: !findSingleColumnUniqueIndex(from.indexes, field.name),
      idsOf: (n) => ids.get(n.id) ?? [],
    };
  }
  const field = c.fields.find((f) => f.name === name);
  const target =
    field?.type === "relation"
      ? app.collections.find(field.collectionId as string)
      : null;
  if (!field || !target) throw new PathError(`invalid relation "${name}"`);
  return {
    target,
    multiple: isMultiple(field),
    idsOf: (n) => uniqueStrings(n.values[name]),
  };
}

// Ids of the records referencing each parent, in insertion order, at most 1000 per parent (PB limit).
function backRelationIds(
  app: ExpandApp,
  from: Collection,
  field: Field,
  parents: Node[],
): Map<string, string[]> {
  const table = quote(from.name);
  const column = `${table}.${quote(field.name)}`;
  const multiple = isMultiple(field);
  const parent = multiple ? `${quote("__je")}.value` : column;
  const source = multiple
    ? `${table}, ${jsonEach(column)} ${quote("__je")}`
    : table;
  const order = from.type === "view" ? "" : `ORDER BY ${table}._rowid_`;
  const rows = app.db.query<{ id: string; parent: string }>(
    `SELECT id, parent FROM (SELECT ${table}.id AS id, ${parent} AS parent, ROW_NUMBER() OVER (PARTITION BY ${parent} ${order}) AS n FROM ${source} WHERE ${parent} IN (SELECT value FROM json_each(?1))) WHERE n <= ?2 ORDER BY n`,
    [JSON.stringify(parents.map((p) => p.id)), BACK_RELATION_LIMIT],
  );
  const ids = new Map<string, string[]>();
  for (const r of rows) {
    const list = ids.get(r.parent) ?? [];
    list.push(r.id);
    ids.set(r.parent, list);
  }
  return ids;
}

function fetch(ctx: Ctx, c: Collection, ids: string[]): Node[] {
  const { app, request, superuser } = ctx;
  if (!superuser && c.viewRule === null)
    throw new PathError(
      `only superusers can view collection "${c.name}" records`,
    );
  const compiler = new QueryCompiler({
    collection: c,
    store: app.collections,
    request,
    now: app.now,
  });
  compiler.allowHidden = true;
  if (!superuser && c.viewRule) compiler.filter(parseFilter(c.viewRule));
  const built = compiler.build();
  const table = quote(c.name);
  const rows = app.db.query<Values>(
    `SELECT DISTINCT ${table}.* FROM ${table} ${built.joins.join(" ")} WHERE ${table}.id IN (SELECT value FROM json_each(?${built.params.length + 1})) AND (${built.sql})`,
    [...built.params, JSON.stringify(ids)],
  );

  const records = rows.map((r) => decode(c, r));
  const managed = managedIds(
    { db: app.db, store: app.collections, now: app.now },
    c,
    records.map((r) => r.id as string),
    request,
    manageRuleOf(c),
  );
  return records.map((values) => {
    const id = values.id as string;
    const isOwner =
      (c.type === "auth" && request?.auth?.id === id) || managed.has(id);
    return {
      id,
      values,
      out: serializeRecord(c, values, { isSuperuser: superuser, isOwner }),
    };
  });
}

const asList = (v: Node | Node[] | undefined): Node[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

// Port of PB Record.MergeExpand.
function mergeExpand(node: Node, from: Expanded | undefined): void {
  if (!from || from.size === 0) return;
  if (!node.expand) {
    node.expand = new Map(from);
    return;
  }
  for (const [key, incoming] of from) {
    const current = node.expand.get(key);
    if (current === undefined) {
      node.expand.set(key, incoming);
      continue;
    }
    const merged = [...asList(current)];
    const byId = new Map(merged.map((r) => [r.id, r]));
    for (const rel of asList(incoming)) {
      const old = byId.get(rel.id);
      if (old) mergeExpand(old, rel.expand);
      else merged.push(rel);
    }
    const list =
      Array.isArray(current) || Array.isArray(incoming) || merged.length === 0;
    node.expand.set(key, list ? merged : merged[0]!);
  }
}

function toJson(node: Node): Values {
  if (!node.expand) return node.out;
  const expand: Values = {};
  for (const [key, value] of node.expand)
    expand[key] = Array.isArray(value) ? value.map(toJson) : toJson(value);
  return sortKeys({ ...node.out, expand: sortKeys(expand) });
}
