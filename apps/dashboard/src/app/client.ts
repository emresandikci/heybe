import {
  createClient,
  localStorageStore,
  type AuthStore,
  type Fetch,
  type HeybeClient,
} from "@heybe/client";

export const AUTH_STORE_KEY = "heybe_superuser_auth";

const unauthorizedHandlers = new WeakMap<HeybeClient, () => void>();

export function onUnauthorized(client: HeybeClient, handler: () => void) {
  unauthorizedHandlers.set(client, handler);
}

export function createDashboardClient(
  opts: { url?: string; fetch?: Fetch; authStore?: AuthStore } = {},
): HeybeClient {
  const send: Fetch =
    opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client = createClient(opts.url ?? "/", {
    fetch: async (input, init) => {
      const res = await send(input, init);
      const token = client.authStore.token;
      // only a 401 for the session's own token ends it (not installer or other tokens)
      if (
        res.status === 401 &&
        token &&
        new Headers(init?.headers).get("Authorization") === token
      )
        unauthorizedHandlers.get(client)?.();
      return res;
    },
    authStore: opts.authStore ?? localStorageStore(AUTH_STORE_KEY),
    autoCancel: false,
  });
  return client;
}
