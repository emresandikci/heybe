import { tokenExpired, tokenPayload } from "./jwt.js";

// Heybe's superusers collection id, and PocketBase's for a PocketBase server
export const SUPERUSER_IDS = ["hbc_3142635823", "pbc_3142635823"];

export type AuthRecord = {
  id: string;
  collectionId: string;
  collectionName: string;
} & Record<string, unknown>;

type Listener = (token: string, record: AuthRecord | null) => void;

export interface AuthStore {
  readonly token: string;
  readonly record: AuthRecord | null;
  readonly isValid: boolean;
  readonly isSuperuser: boolean;
  save(token: string, record: AuthRecord | null): void;
  clear(): void;
  onChange(fn: Listener, fireImmediately?: boolean): () => void;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function createStore(
  now: () => number,
  initial: { token: string; record: AuthRecord | null },
  persist?: (token: string, record: AuthRecord | null) => void,
) {
  let token = initial.token;
  let record = initial.record;
  const listeners: Listener[] = [];

  const update = (t: string, r: AuthRecord | null, write: boolean) => {
    token = t;
    record = r;
    if (write) persist?.(t, r);
    for (const fn of [...listeners]) fn(t, r);
  };

  const store: AuthStore = {
    get token() {
      return token;
    },
    get record() {
      return record;
    },
    get isValid() {
      return !tokenExpired(token, now());
    },
    get isSuperuser() {
      const payload = tokenPayload(token);
      return (
        payload.type === "auth" &&
        (record?.collectionName === "_superusers" ||
          SUPERUSER_IDS.includes(payload.collectionId as string))
      );
    },
    save: (t, r) => update(t, r, true),
    clear: () => update("", null, true),
    onChange(fn, fireImmediately = false) {
      listeners.push(fn);
      if (fireImmediately) fn(token, record);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    store,
    replace: (t: string, r: AuthRecord | null) => update(t, r, false),
  };
}

export function memoryStore(now: () => number = Date.now): AuthStore {
  return createStore(now, { token: "", record: null }).store;
}

function parse(raw: string | null) {
  try {
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (data && typeof data === "object") {
      const { token, record } = data as Record<string, unknown>;
      return {
        token: typeof token === "string" ? token : "",
        record:
          record && typeof record === "object" ? (record as AuthRecord) : null,
      };
    }
  } catch {}
  return { token: "", record: null };
}

// Storage can be missing or throw (private mode, blocked storage, quota): like PB's LocalAuthStore the
// in-memory state stays authoritative and storage errors are ignored.
function safeStorage(get: () => StorageLike | undefined): StorageLike {
  const attempt = <T>(fn: (s: StorageLike) => T, fallback: T): T => {
    try {
      const s = get();
      return s ? fn(s) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (k) => attempt((s) => s.getItem(k), null),
    setItem: (k, v) => attempt((s) => s.setItem(k, v), undefined),
    removeItem: (k) => attempt((s) => s.removeItem(k), undefined),
  };
}

export function localStorageStore(
  key = "heybe_auth",
  storage?: StorageLike,
  now: () => number = Date.now,
): AuthStore {
  const safe = safeStorage(() => storage ?? globalThis.localStorage);
  const { store, replace } = createStore(
    now,
    parse(safe.getItem(key)),
    (token, record) => {
      if (token || record) safe.setItem(key, JSON.stringify({ token, record }));
      else safe.removeItem(key);
    },
  );
  const g = globalThis as {
    addEventListener?: (
      type: string,
      fn: (e: { key: string | null; newValue: string | null }) => void,
    ) => void;
  };
  g.addEventListener?.("storage", (e) => {
    if (e.key !== key) return;
    const next = parse(e.newValue);
    replace(next.token, next.record);
  });
  return store;
}
