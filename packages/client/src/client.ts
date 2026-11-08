import type { CollectionName, Collections } from "@heybe/query";
import {
  localStorageStore,
  memoryStore,
  type AuthStore,
} from "./auth-store.js";
import { defaultEnv, type Env, type Fetch } from "./env.js";
import { createAuth, type AuthClient } from "./auth.js";
import { createRecords, type RecordsClient } from "./records.js";
import { createAutoRefresh } from "./refresh.js";
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
  autoCancel: boolean;
  buildURL(path: string): string;
  send<T>(path: string, opts?: SendOptions): Promise<T>;
  cancelRequest(key: string): void;
  cancelAllRequests(): void;
  records<N extends CollectionName>(name: N): RecordsClient<Collections[N]>;
  records(name: string): RecordsClient<Record<string, unknown>>;
  auth<N extends CollectionName>(name: N): AuthClient<Collections[N]>;
  auth(name: string): AuthClient<Record<string, unknown>>;
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
        { method: "POST" },
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
    createClientWith(url, { lang, authStore: memoryStore(env.now) }, env);
  const client: HeybeClient = {
    url,
    lang,
    authStore,
    autoCancel: opts.autoCancel ?? true,
    buildURL: (path) => buildURL(url, path),
    ...sender,
    records: (name: string) => createRecords(client, name),
    auth: (name: string) => createAuth(client, name, { autoRefresh, fork }),
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
