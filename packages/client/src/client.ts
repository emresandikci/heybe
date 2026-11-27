import type { CollectionName, Collections } from "@heybejs/query";
import {
  localStorageStore,
  memoryStore,
  type AuthStore,
} from "./auth-store.js";
import { defaultEnv, type Env, type Fetch } from "./env.js";
import {
  createCollections,
  createCrons,
  createHealth,
  createSettings,
  type CollectionsService,
  type CronsService,
  type HealthService,
  type SettingsService,
} from "./admin.js";
import { createAuth, type AuthClient } from "./auth.js";
import { createBackups, type BackupsService } from "./backups.js";
import { createBatch, type Batch } from "./batch.js";
import { createFiles, type Files } from "./files.js";
import { createLogs, type LogsService } from "./logs.js";
import { createRealtime, type Realtime } from "./realtime.js";
import { createRecords, type RecordsClient } from "./records.js";
import { createAutoRefresh } from "./refresh.js";
import { createSql, type SqlService } from "./sql.js";
import { buildURL, createSender, type SendOptions } from "./send.js";

export interface ClientOptions {
  fetch?: Fetch;
  lang?: string;
  autoCancel?: boolean;
  authStore?: AuthStore;
  autoRefreshThreshold?: number;
}

export interface HeybeClient {
  readonly url: string;
  readonly lang: string;
  readonly authStore: AuthStore;
  readonly realtime: Realtime;
  readonly files: Files;
  readonly collections: CollectionsService;
  readonly settings: SettingsService;
  readonly crons: CronsService;
  readonly health: HealthService;
  readonly logs: LogsService;
  readonly backups: BackupsService;
  readonly sql: SqlService;
  autoCancel: boolean;
  buildURL(path: string): string;
  send<T>(path: string, opts?: SendOptions): Promise<T>;
  cancelRequest(key: string): void;
  cancelAllRequests(): void;
  records<N extends CollectionName>(name: N): RecordsClient<Collections[N]>;
  records(name: string): RecordsClient<Record<string, unknown>>;
  auth<N extends CollectionName>(name: N): AuthClient<Collections[N]>;
  auth(name: string): AuthClient<Record<string, unknown>>;
  batch(): Batch;
}

export function createClient(
  url: string,
  opts: ClientOptions = {},
): HeybeClient {
  return createClientWith(url, opts, {
    ...defaultEnv,
    fetch: opts.fetch ?? defaultEnv.fetch,
  });
}

export function createClientWith(
  url: string,
  opts: ClientOptions,
  env: Env,
): HeybeClient {
  const lang = opts.lang ?? "en-US";
  const authStore = opts.authStore ?? defaultStore(env.now);
  const autoRefresh = createAutoRefresh({
    store: authStore,
    now: env.now,
    threshold: opts.autoRefreshThreshold,
    refresh: (collection) =>
      client.send(
        `/api/collections/${encodeURIComponent(collection)}/auth-refresh`,
        { method: "POST", requestKey: null },
      ),
  });
  const sender = createSender({
    url,
    lang,
    env,
    token: () => authStore.token,
    autoCancel: () => client.autoCancel,
    beforeSend: autoRefresh.before,
  });
  const fork = () =>
    createClientWith(
      url,
      { lang, autoCancel: client.autoCancel, authStore: memoryStore(env.now) },
      env,
    );
  const realtime = (store = authStore) =>
    createRealtime({
      env,
      authStore: store,
      buildURL: (path) => buildURL(url, path),
      send: sender.send,
      cancelRequest: sender.cancelRequest,
    });
  const client: HeybeClient = {
    url,
    lang,
    authStore,
    autoCancel: opts.autoCancel ?? true,
    buildURL: (path) => buildURL(url, path),
    ...sender,
    realtime: realtime(),
    files: createFiles({
      send: sender.send,
      buildURL: (path) => buildURL(url, path),
    }),
    collections: createCollections(sender),
    settings: createSettings(sender),
    crons: createCrons(sender),
    health: createHealth(sender),
    logs: createLogs(sender),
    backups: createBackups({
      send: sender.send,
      buildURL: (path) => buildURL(url, path),
    }),
    sql: createSql(sender),
    batch: () => createBatch(client),
    records: (name: string) => createRecords(client, name),
    auth: (name: string) =>
      createAuth(client, name, {
        autoRefresh,
        fork,
        // own store, so auth changes elsewhere do not restart an OAuth2 flow
        realtime: () => realtime(memoryStore(env.now)),
      }),
  } as HeybeClient;
  return client;
}

function defaultStore(now: () => number): AuthStore {
  try {
    if (typeof window !== "undefined" && window.localStorage)
      return localStorageStore(undefined, undefined, now);
  } catch {}
  return memoryStore(now);
}
