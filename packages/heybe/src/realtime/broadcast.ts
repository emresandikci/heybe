import { toAst } from "@heybe/query";
import type { App } from "../app";
import type { Collection } from "../collections/model";
import type { RequestInfo } from "../filter/compile";
import { parseFilter } from "../filter/parse";
import { logUnexpected } from "../http/errors";
import type { AuthState } from "../http/router";
import {
  checkClientFilterFields,
  enrichExpanded,
  triggerEnrich,
} from "../http/routes/records";
import { expandModels } from "../records/expand";
import { internalRecords } from "../records/internal";
import { RecordModel } from "../records/model";
import { isSuperuser } from "../records/read";
import { matchesRecord } from "../records/rules";
import { pickFields } from "../records/serialize";
import { valuesOf } from "../records/service";
import type { Client, Message } from "./broker";

// Port of the record broadcasts and client auth hooks of PB apis/realtime.go.

export const AUTH_KEY = "auth";
export const IP_KEY = "pbRealtimeClientIP";

type Action = "create" | "update" | "delete";

export const clientAuth = (client: Client): AuthState | null =>
  (client.get(AUTH_KEY) as AuthState | null | undefined) ?? null;

export const isSameAuth = (a: AuthState | null, b: AuthState | null) =>
  a === null
    ? b === null
    : b !== null &&
      a.record.id === b.record.id &&
      a.collection.id === b.collection.id;

const dryCacheKey = (action: Action, record: RecordModel) =>
  `${action}/${record.collection.name}/${record.id}`;

// PB realtimeCanAccessRecord: the rule (null is superuser only), then the subscription filter.
function canAccess(
  app: App,
  c: Collection,
  id: string,
  rule: string | null,
  info: RequestInfo,
): boolean {
  try {
    if (!isSuperuser(info)) {
      if (rule === null) return false;
      if (rule !== "" && !matchesRecord(app, c, id, parseFilter(rule), info))
        return false;
    }
    const filter = info.query.filter ?? "";
    if (filter === "") return true;
    checkClientFilterFields(info);
    const expr = parseFilter(filter);
    const byId = toAst({ id })!;
    const { items } = internalRecords(app, c.name).query({
      filter: expr ? { kind: "and", items: [byId, expr] } : byId,
      perPage: 1,
      skipTotal: true,
      request: info,
      raw: true,
    });
    return items.length > 0;
  } catch {
    return false;
  }
}

// canAccess, run against the committed data for the delete messages
type Access = (
  c: Collection,
  id: string,
  rule: string | null,
  info: RequestInfo,
) => boolean;

async function message(
  app: App,
  access: Access,
  record: RecordModel,
  action: Action,
  topic: string,
  info: RequestInfo,
  auth: AuthState | null,
): Promise<Message | null> {
  const c = record.collection;
  const clean = new RecordModel(c, valuesOf(record), false);
  if (isSuperuser(info)) clean.unhide(...c.fields.map((f) => f.name));
  try {
    await triggerEnrich(app, info, [clean], async () => {
      const expand = info.query.expand ?? "";
      if (expand !== "")
        await expandModels(
          app,
          c,
          [clean],
          expand.split(","),
          info,
          (rc, rs, r) => enrichExpanded(app, rc, rs, r),
        );
      if (
        c.type === "auth" &&
        ((auth?.record.id === clean.id && auth.collection.id === c.id) ||
          access(c, clean.id, c.manageRule as string | null, info))
      )
        clean.ignoreEmailVisibility(true);
    });
  } catch {
    return null;
  }
  let json = clean.toJSON();
  const fields = info.query.fields ?? "";
  if (fields !== "")
    try {
      json = pickFields(json, fields);
    } catch {}
  return { name: topic, data: JSON.stringify({ record: json, action }) };
}

// PB realtimeBroadcastRecord: one message per matching subscription the client may read; with
// `dryCache` they are kept on the client under the delete key instead of sent.
async function broadcastRecord(
  app: App,
  action: Action,
  record: RecordModel,
  dryCache: boolean,
  access: Access,
): Promise<void> {
  const clients = app.realtime.clients();
  if (clients.length === 0) return;
  const c = record.collection;
  const id = record.id;
  const topics: [string, string | null][] = [
    [`${c.name}/${id}?`, c.viewRule],
    [`${c.id}/${id}?`, c.viewRule],
    [`${c.name}/*?`, c.listRule],
    [`${c.id}/*?`, c.listRule],
    [`${c.name}?`, c.listRule],
    [`${c.id}?`, c.listRule],
  ];
  const key = dryCacheKey(action, record);
  for (const client of clients) {
    for (const [prefix, rule] of topics) {
      const subs = client.subscriptions(prefix);
      if (subs.size === 0) continue;
      const auth = clientAuth(client);
      for (const [topic, options] of subs) {
        const info: RequestInfo = {
          auth: auth?.record ?? null,
          authCollection: auth?.collection.name ?? null,
          body: {},
          query: options.query,
          headers: options.headers,
          method: "GET",
          context: "realtime",
        };
        if (!access(c, id, rule, info)) continue;
        const m = await message(app, access, record, action, topic, info, auth);
        if (!m) continue;
        if (!dryCache) client.send(m);
        else client.set(key, [...((client.get(key) as Message[]) ?? []), m]);
      }
    }
  }
}

async function broadcastLogged(
  app: App,
  action: Action,
  record: RecordModel,
  dryCache = false,
): Promise<void> {
  try {
    // like PB, only the access checks of the delete messages leave its transaction
    const access: Access = dryCache
      ? (...args) => app.db.committed(() => canAccess(app, ...args))
      : (...args) => canAccess(app, ...args);
    await broadcastRecord(app, action, record, dryCache, access);
  } catch (err) {
    logUnexpected(err);
  }
}

function eachAuthClient(
  app: App,
  match: (auth: AuthState) => boolean,
  fn: (client: Client, auth: AuthState) => void,
): void {
  for (const client of app.realtime.clients()) {
    const auth = clientAuth(client);
    if (auth && match(auth)) fn(client, auth);
  }
}

const secret = (c: Collection) =>
  (c.authToken as { secret?: string } | undefined)?.secret;

export function registerRealtimeHooks(app: App): void {
  const h = app.hooks;
  const late = { priority: -99 };
  const unsetByCollection = (a: App, name: string) =>
    eachAuthClient(
      a,
      (auth) => auth.collection.name === name,
      (client) => client.unset(AUTH_KEY),
    );

  h.onCollectionUpdate.bind(async (e) => {
    if (e.collection.type !== "auth") return e.next();
    const cached = e.app.collections.find(e.collection.id);
    await e.next();
    if (cached && secret(cached) !== secret(e.collection))
      unsetByCollection(e.app, e.collection.name);
  }, late);

  h.onCollectionAfterDeleteSuccess.bind((e) => {
    if (e.collection.type === "auth")
      unsetByCollection(e.app, e.collection.name);
    return e.next();
  }, late);

  h.onModelAfterUpdateSuccess.bind((e) => {
    const r = e.model;
    if (r instanceof RecordModel && r.collection.type === "auth")
      eachAuthClient(
        e.app,
        (auth) =>
          auth.record.id === r.id && auth.collection.name === r.collection.name,
        (client, auth) => {
          if (auth.record.tokenKey !== r.get("tokenKey"))
            client.unset(AUTH_KEY);
          else
            client.set(AUTH_KEY, {
              ...auth,
              record: valuesOf(r),
              collection: r.collection,
            });
        },
      );
    return e.next();
  }, late);

  h.onModelAfterDeleteSuccess.bind((e) => {
    const r = e.model;
    if (r instanceof RecordModel && r.collection.type === "auth")
      eachAuthClient(
        e.app,
        (auth) =>
          auth.record.id === r.id && auth.collection.name === r.collection.name,
        (client) => client.unset(AUTH_KEY),
      );
    return e.next();
  }, late);

  h.onModelAfterCreateSuccess.bind(async (e) => {
    if (e.model instanceof RecordModel)
      await broadcastLogged(e.app, "create", e.model);
    return e.next();
  }, late);

  h.onModelAfterUpdateSuccess.bind(async (e) => {
    if (e.model instanceof RecordModel)
      await broadcastLogged(e.app, "update", e.model);
    return e.next();
  }, late);

  // the delete messages are built before the delete
  h.onModelDelete.bind(
    async (e) => {
      const r = e.model;
      if (r instanceof RecordModel)
        await broadcastLogged(e.app, "delete", r, true);
      return e.next();
    },
    { priority: 99 },
  );

  h.onModelAfterDeleteSuccess.bind((e) => {
    const r = e.model;
    if (r instanceof RecordModel) {
      const key = dryCacheKey("delete", r);
      for (const client of e.app.realtime.clients()) {
        const messages = client.get(key) as Message[] | undefined;
        if (!messages) continue;
        client.unset(key);
        for (const m of messages) client.send(m);
      }
    }
    return e.next();
  }, late);

  h.onModelAfterDeleteError.bind((e) => {
    const r = e.model;
    if (r instanceof RecordModel) {
      const key = dryCacheKey("delete", r);
      for (const client of e.app.realtime.clients()) client.unset(key);
    }
    return e.next();
  }, late);
}
