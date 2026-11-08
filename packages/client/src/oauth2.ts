import type {
  AuthClient,
  AuthOptions,
  AuthResponse,
  OAuth2Provider,
} from "./auth.js";
import { HeybeError } from "./error.js";
import type { Realtime } from "./realtime.js";

export interface OAuth2Config<T> extends AuthOptions {
  provider: string;
  scopes?: string[];
  createData?: Partial<T>;
  urlCallback?: (url: string) => void | Promise<void>;
}

interface OAuth2Deps<T> {
  auth: Pick<AuthClient<T>, "methods" | "withOAuth2Code">;
  realtime(): Realtime;
  buildURL(path: string): string;
}

function failure(message: string, isAbort = false): HeybeError {
  const err = new HeybeError({ isAbort, cause: new Error(message) });
  err.message = message;
  return err;
}

function openPopup(url?: string): Window | null {
  const win = (globalThis as { window?: Window }).window;
  if (!win?.open)
    throw failure(
      "Not in a browser context - please pass a custom urlCallback function.",
    );
  const width = Math.min(1024, win.innerWidth);
  const height = Math.min(768, win.innerHeight);
  const left = win.innerWidth / 2 - width / 2;
  const top = win.innerHeight / 2 - height / 2;
  return win.open(
    url,
    "popup_window",
    `width=${width},height=${height},top=${top},left=${left},resizable,menubar=no`,
  );
}

function replaceQuery(url: string, replacements: Record<string, string>) {
  const i = url.indexOf("?");
  const path = i < 0 ? url : url.slice(0, i);
  const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
  const params = new Map<string, string>();
  for (const pair of i < 0 ? [] : url.slice(i + 1).split("&")) {
    if (!pair) continue;
    const [key, value = ""] = pair.split("=");
    params.set(decode(key!), decode(value));
  }
  for (const [key, value] of Object.entries(replacements))
    params.set(key, value);
  const query = [...params]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return query ? `${path}?${query}` : path;
}

export async function authWithOAuth2<T>(
  deps: OAuth2Deps<T>,
  config: OAuth2Config<T>,
): Promise<AuthResponse<T>> {
  const { provider: name, scopes, createData, urlCallback, ...opts } = config;
  // opened before any await so browsers (Safari) allow it
  let popup = urlCallback ? null : openPopup();
  const realtime = deps.realtime();
  let onAbort = () => {};
  let provider: OAuth2Provider | undefined;
  let redirectURL = "";
  let code: string;
  let done = false;

  try {
    const methods = await deps.auth.methods({
      requestKey: opts.requestKey,
      signal: opts.signal,
    });
    provider = methods.oauth2.providers.find((p) => p.name === name);
    if (!provider) throw failure(`Missing or invalid provider "${name}".`);
    const { authURL } = provider;
    redirectURL = deps.buildURL("/api/oauth2-redirect");

    code = await new Promise<string>((resolve, reject) => {
      onAbort = () => reject(failure("manually cancelled", true));
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      realtime.onDisconnect = (topics) => {
        if (topics.length) reject(failure("realtime connection interrupted"));
      };
      (async () => {
        await realtime.subscribe("@oauth2", (e) => {
          if (!e.state || e.state !== realtime.clientId)
            reject(failure("State parameters don't match."));
          else if (e.error || !e.code)
            reject(
              failure("OAuth2 redirect error or missing code: " + e.error),
            );
          else resolve(e.code);
        });
        if (done) return;
        const replacements: Record<string, string> = {
          state: realtime.clientId,
        };
        if (scopes?.length) replacements.scope = scopes.join(" ");
        const url = replaceQuery(authURL + redirectURL, replacements);
        if (urlCallback) await urlCallback(url);
        else if (popup) popup.location.href = url;
        else popup = openPopup(url);
      })().catch(reject);
    });
  } catch (err) {
    throw err instanceof HeybeError ? err : new HeybeError({ cause: err });
  } finally {
    done = true;
    realtime.onDisconnect = undefined;
    opts.signal?.removeEventListener("abort", onAbort);
    popup?.close();
    void realtime.unsubscribe().catch(() => {});
  }

  return deps.auth.withOAuth2Code(
    provider.name,
    code,
    provider.codeVerifier,
    redirectURL,
    createData,
    opts,
  );
}
