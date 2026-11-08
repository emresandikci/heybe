import type { AuthRecord, AuthStore } from "./auth-store.js";
import { tokenExpired } from "./jwt.js";
import { hasAuthorization } from "./send.js";

export interface Reauth {
  threshold: number;
  record: AuthRecord;
  run(): Promise<unknown>;
}

export interface AutoRefresh {
  register(reauth: Reauth): void;
  reset(): void;
  before(
    path: string,
    headers?: Record<string, string>,
  ): Promise<void> | undefined;
}

const SKIPPED = ["/auth-refresh", "/auth-with-password"];

export function createAutoRefresh(cfg: {
  store: AuthStore;
  now: () => number;
  threshold?: number;
  refresh(collection: string): Promise<{ token: string; record: AuthRecord }>;
}): AutoRefresh {
  const { store } = cfg;
  let reauth: Reauth | null = null;
  let pending: Promise<void> | null = null;

  store.onChange((token, record) => {
    if (
      reauth &&
      (!token ||
        record?.id !== reauth.record.id ||
        record?.collectionId !== reauth.record.collectionId)
    )
      reauth = null;
  });

  const expiring = (threshold: number) =>
    store.isValid &&
    !!store.record &&
    tokenExpired(store.token, cfg.now(), threshold);

  async function run(r: Reauth | null, threshold: number) {
    let valid = store.isValid;
    if (expiring(threshold)) {
      const { token, record } = store;
      try {
        const data = await cfg.refresh(
          record!.collectionName || record!.collectionId,
        );
        if (store.token === token) store.save(data.token, data.record);
      } catch {
        valid = false;
      }
    }
    if (!valid && r) await r.run();
  }

  return {
    register(r) {
      reauth = r;
    },
    reset() {
      reauth = null;
    },
    before(path, headers) {
      if (SKIPPED.some((p) => path.endsWith(p))) return;
      if (hasAuthorization(headers)) return;
      if (pending) return pending;
      const r = reauth;
      const threshold = r?.threshold ?? cfg.threshold;
      if (threshold === undefined) return;
      if (!expiring(threshold) && !(r && !store.isValid)) return;
      pending = run(r, threshold).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
