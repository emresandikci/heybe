import type { CollectionName, Collections } from "@heybe/query";
import {
  localStorageStore,
  memoryStore,
  type AuthStore,
} from "./auth-store.js";
import { defaultEnv, type Env, type Fetch } from "./env.js";
import { createRecords, type RecordsClient } from "./records.js";
import { buildURL, createSender, type SendOptions } from "./send.js";

export interface ClientOptions {
  fetch?: Fetch;
  lang?: string;
  autoCancel?: boolean;
  authStore?: AuthStore;
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
  const sender = createSender({
    url,
    lang,
    env,
    token: () => authStore.token,
    autoCancel: () => client.autoCancel,
  });
  const client: HeybeClient = {
    url,
    lang,
    authStore,
    autoCancel: opts.autoCancel ?? true,
    buildURL: (path) => buildURL(url, path),
    ...sender,
    records: (name: string) => createRecords(client, name),
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
