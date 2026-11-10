import {
  createClient,
  localStorageStore,
  type AuthStore,
  type Fetch,
  type HeybeClient,
} from "@heybe/client";

export const AUTH_STORE_KEY = "heybe_superuser_auth";

export function createDashboardClient(
  opts: { url?: string; fetch?: Fetch; authStore?: AuthStore } = {},
): HeybeClient {
  return createClient(opts.url ?? "/", {
    fetch: opts.fetch,
    authStore: opts.authStore ?? localStorageStore(AUTH_STORE_KEY),
    autoCancel: false,
  });
}
