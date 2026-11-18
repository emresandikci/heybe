import type { Expr } from "@heybe/query";
import { quote } from "../collections/ddl";
import type { Collection } from "../collections/model";
import type { CollectionStore } from "../collections/store";
import type { Db } from "../db";
import { fields } from "../fields";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { parseFilter } from "../filter/parse";

type Values = Record<string, unknown>;

export const isSuperuser = (info: RequestInfo) =>
  info.authCollection === "_superusers" && info.auth !== null;

export function decode(c: Collection, raw: Values): Values {
  return Object.fromEntries(
    c.fields.map((f) => [f.name, fields[f.type].fromDb(raw[f.name], f)]),
  );
}

export function manageRuleOf(c: Collection): Expr | null {
  const rule = c.manageRule;
  if (c.type !== "auth" || typeof rule !== "string" || rule === "") return null;
  try {
    return parseFilter(rule);
  } catch {
    return null;
  }
}

// ids of auth records the requester manages (PB autoResolveRecordsFlags)
export function managedIds(
  { db, store, now }: { db: Db; store: CollectionStore; now: () => Date },
  c: Collection,
  ids: string[],
  request: RequestInfo | null,
  manageRule: Expr | null | undefined,
): Set<string> {
  if (!manageRule || !request?.auth || c.type !== "auth" || ids.length === 0)
    return new Set();
  const built = new QueryCompiler({ collection: c, store, request, now })
    .filter(manageRule)
    .build();
  const table = quote(c.name);
  const rows = db.query<{ id: string }>(
    `SELECT DISTINCT ${table}.id FROM ${table} ${built.joins.join(" ")} WHERE (${built.sql}) AND ${table}.id IN (SELECT value FROM json_each(?${built.params.length + 1}))`,
    [...built.params, JSON.stringify(ids)],
  );
  return new Set(rows.map((r) => r.id));
}
