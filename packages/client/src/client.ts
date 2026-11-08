import { defaultEnv, type Env, type Fetch } from "./env.js";
import { buildURL, createSender, type SendOptions } from "./send.js";

export interface ClientOptions {
  fetch?: Fetch;
  lang?: string;
  autoCancel?: boolean;
}

export interface HeybeClient {
  readonly url: string;
  readonly lang: string;
  autoCancel: boolean;
  buildURL(path: string): string;
  send<T>(path: string, opts?: SendOptions): Promise<T>;
  cancelRequest(key: string): void;
  cancelAllRequests(): void;
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
  const sender = createSender({
    url,
    lang,
    env,
    token: () => "",
    autoCancel: () => client.autoCancel,
  });
  const client: HeybeClient = {
    url,
    lang,
    autoCancel: opts.autoCancel ?? true,
    buildURL: (path) => buildURL(url, path),
    ...sender,
  };
  return client;
}
