import { type Expr, toAst } from "@heybe/query";
import type { App } from "../app";
import { quote } from "../collections/ddl";
import type { Collection } from "../collections/model";
import { QueryCompiler, type RequestInfo } from "../filter/compile";
import { parseFilter } from "../filter/parse";
import { ApiError, logUnexpected } from "../http/errors";
import type { RequestEvent } from "../http/router";
import { randomSecret } from "../util";
import { isSuperuser } from "./read";
import { dbValues, draftValues } from "./service";

type Values = Record<string, unknown>;
export type RuleAction = "list" | "view" | "create" | "update" | "delete";

const infos = new WeakMap<RequestEvent, RequestInfo>();

const FORBIDDEN = "Only superusers can perform this action.";

// PB inflector.Snakecase on the canonical header key ("X-Api-Key" -> "x_api_key")
export const headerKey = (name: string) =>
  name
    .split(/[\W_]+/)
    .filter((w) => w !== "")
    .join("_")
    .toLowerCase();

export function buildRequestInfo(
  e: RequestEvent,
  body: Values,
  context = "default",
): RequestInfo {
  const query = new Map<string, string>();
  for (const [k, v] of e.query) if (!query.has(k)) query.set(k, v);
  const headers = new Map<string, string>();
  for (const [k, v] of e.req.headers) headers.set(headerKey(k), v);
  return {
    auth: e.auth?.record ?? null,
    authCollection: e.auth?.collection.name ?? null,
    body,
    query: Object.fromEntries(query),
    headers: Object.fromEntries(headers),
    method: e.req.method,
    context,
  };
}

// Port of PB RequestEvent.RequestInfo: built once per request, the body is read on first use.
export async function requestInfo(e: RequestEvent): Promise<RequestInfo> {
  let info = infos.get(e);
  if (!info) {
    let body: Values;
    try {
      body = await e.body();
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) throw err;
      logUnexpected(err);
      throw new ApiError(400, "");
    }
    info = buildRequestInfo(e, body);
    infos.set(e, info);
  }
  return info;
}

// A null rule is superuser only (403). Returns the rule to apply, or null when nothing restricts the request.
// For view/update/delete with a `recordId`, a record outside the rule is a 404.
export async function checkRule(
  app: App,
  collection: Collection,
  rule: string | null,
  action: RuleAction,
  e: RequestEvent,
  recordId?: string,
): Promise<Expr | null> {
  return ruleFilter(
    app,
    collection,
    rule,
    action,
    await requestInfo(e),
    recordId,
  );
}

export function ruleFilter(
  app: App,
  collection: Collection,
  rule: string | null,
  action: RuleAction,
  info: RequestInfo,
  recordId?: string,
): Expr | null {
  if (!isSuperuser(info) && rule === null) throw new ApiError(403, FORBIDDEN);
  let expr: Expr | null = null;
  try {
    if (!isSuperuser(info) && rule) expr = parseFilter(rule);
    if (recordId !== undefined && action !== "list" && action !== "create") {
      if (!matchesRecord(app, collection, recordId, expr, info))
        throw new ApiError(404, "");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logUnexpected(err);
    throw new ApiError(action === "list" ? 400 : 404, "");
  }
  return expr;
}

export function matchesRecord(
  app: App,
  c: Collection,
  id: string,
  rule: Expr | null,
  info: RequestInfo,
): boolean {
  const { items } = app.records(c.name).query({
    ruleFilter: rule,
    filter: toAst({ id }),
    perPage: 1,
    skipTotal: true,
    request: info,
  });
  return items.length > 0;
}

// The create rule runs against the submitted record as a one-row CTE, like PB recordCreate.
export function matchesDraft(
  app: App,
  c: Collection,
  values: Values,
  rule: string,
  info: RequestInfo,
): boolean {
  // Fixed name: the draft table only exists inside this query, and a stable SQL text keeps the statement cache bounded.
  const suffix = "__pb_create__";
  const draft = { ...c, id: c.id + suffix, name: c.name + suffix };
  const row = { ...values };
  if (row.id === "") row.id = "__temp_id__" + suffix + randomSecret(6);
  if (c.type === "auth") row.verified = false;

  const built = new QueryCompiler({
    collection: draft,
    store: app.collections,
    request: info,
    now: app.now,
  })
    .filter(parseFilter(rule))
    .build();
  const offset = built.params.length;
  const selects = c.fields.map(
    (f, i) => `?${offset + i + 1} AS ${quote(f.name)}`,
  );
  const table = quote(draft.name);
  return (
    app.db.get(
      `WITH ${table} AS (SELECT ${selects.join(", ")}) SELECT 1 FROM ${table} ${built.joins.join(" ")} WHERE ${built.sql} LIMIT 1`,
      [...built.params, ...dbValues(c, row)],
    ) !== null
  );
}

export function checkCreateRule(
  app: App,
  c: Collection,
  data: Values,
  info: RequestInfo,
): void {
  if (isSuperuser(info) || !c.createRule) return;
  let ok = false;
  try {
    ok = matchesDraft(app, c, draftValues(c, null, data), c.createRule, info);
  } catch (err) {
    logUnexpected(err);
  }
  if (!ok) throw new ApiError(400, "Failed to create record.");
}

// Port of PB hasAuthManageAccess: the auth record satisfies the auth collection manageRule.
export function hasManageAccess(
  app: App,
  c: Collection,
  info: RequestInfo,
  target: { id: string } | { draft: Values },
): boolean {
  const rule = c.manageRule;
  if (c.type !== "auth" || typeof rule !== "string" || rule === "")
    return false;
  if (!info.auth) return false;
  try {
    return "id" in target
      ? matchesRecord(app, c, target.id, parseFilter(rule), info)
      : matchesDraft(app, c, draftValues(c, null, target.draft), rule, info);
  } catch (err) {
    logUnexpected(err);
    return false;
  }
}
