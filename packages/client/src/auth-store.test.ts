import { afterEach, describe, expect, test } from "bun:test";
import {
  localStorageStore,
  memoryStore,
  type AuthRecord,
  type StorageLike,
} from "./auth-store.js";
import { createClient, createClientWith } from "./client.js";
import { tokenExpired, tokenPayload } from "./jwt.js";
import { fakeEnv } from "./test-env.js";

function jwt(payload: unknown): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

const rec = (collectionName = "users"): AuthRecord => ({
  id: "r1",
  collectionId: "c1",
  collectionName,
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: StorageLike & { data: Map<string, string> } = {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return storage;
}

describe("jwt", () => {
  test("token without exp is valid", () => {
    expect(tokenExpired(jwt({ a: 1 }), 5000)).toBe(false);
  });

  test("expired token is invalid", () => {
    expect(tokenExpired(jwt({ exp: 10 }), 11_000)).toBe(true);
    expect(tokenExpired(jwt({ exp: 10 }), 9_000)).toBe(false);
  });

  test("threshold makes a soon-expiring token expired", () => {
    const token = jwt({ exp: 100 });
    expect(tokenExpired(token, 50_000)).toBe(false);
    expect(tokenExpired(token, 50_000, 60)).toBe(true);
  });

  test("garbage token is invalid", () => {
    expect(tokenExpired("garbage", 0)).toBe(true);
    expect(tokenExpired("", 0)).toBe(true);
    expect(tokenPayload("a.!!!.c")).toEqual({});
  });

  test("UTF-8 payload decodes", () => {
    expect(tokenPayload(jwt({ name: "Çağrı ü€" }))).toEqual({
      name: "Çağrı ü€",
    });
  });
});

describe("memoryStore", () => {
  test("isSuperuser by collectionName and by collectionId", () => {
    const a = memoryStore();
    a.save(jwt({ type: "auth" }), rec("_superusers"));
    expect(a.isSuperuser).toBe(true);
    const b = memoryStore();
    b.save(jwt({ type: "auth", collectionId: "pbc_3142635823" }), null);
    expect(b.isSuperuser).toBe(true);
    const c = memoryStore();
    c.save(jwt({ type: "auth" }), rec());
    expect(c.isSuperuser).toBe(false);
    const d = memoryStore();
    d.save(jwt({ type: "file" }), rec("_superusers"));
    expect(d.isSuperuser).toBe(false);
  });

  test("isValid uses the injected clock", () => {
    let now = 0;
    const store = memoryStore(() => now);
    store.save(jwt({ exp: 10 }), rec());
    expect(store.isValid).toBe(true);
    now = 11_000;
    expect(store.isValid).toBe(false);
  });

  test("save fires onChange; unsubscribe stops it; fireImmediately fires once with the current state", () => {
    const store = memoryStore();
    const calls: [string, AuthRecord | null][] = [];
    const off = store.onChange((t, r) => calls.push([t, r]));
    store.save("t1", rec());
    expect(calls).toEqual([["t1", rec()]]);
    off();
    store.save("t2", rec());
    expect(calls).toHaveLength(1);

    const immediate: string[] = [];
    store.onChange((t) => immediate.push(t), true);
    expect(immediate).toEqual(["t2"]);
  });

  test("clear empties token and record", () => {
    const store = memoryStore();
    store.save("t", rec());
    store.clear();
    expect(store.token).toBe("");
    expect(store.record).toBeNull();
  });
});

describe("localStorageStore", () => {
  const g = globalThis as { addEventListener?: unknown };
  const saved = g.addEventListener;
  afterEach(() => {
    g.addEventListener = saved;
  });

  test("persists and reloads", () => {
    const storage = fakeStorage();
    localStorageStore("k", storage).save("t", rec());
    expect(JSON.parse(storage.data.get("k")!)).toEqual({
      token: "t",
      record: rec(),
    });
    const reloaded = localStorageStore("k", storage);
    expect(reloaded.token).toBe("t");
    expect(reloaded.record).toEqual(rec());
    reloaded.clear();
    expect(storage.data.has("k")).toBe(false);
  });

  test("default key is heybe_auth", () => {
    const storage = fakeStorage();
    localStorageStore(undefined, storage).save("t", null);
    expect(storage.data.has("heybe_auth")).toBe(true);
  });

  test("corrupt storage JSON loads as empty", () => {
    for (const raw of ["{nope", "5", "null"]) {
      const store = localStorageStore("k", fakeStorage({ k: raw }));
      expect(store.token).toBe("");
      expect(store.record).toBeNull();
    }
  });

  test("storage event from another tab updates the store and fires onChange", () => {
    let handler: (e: {
      key: string | null;
      newValue: string | null;
    }) => void = () => {};
    g.addEventListener = (type: string, fn: typeof handler) => {
      if (type === "storage") handler = fn;
    };
    const storage = fakeStorage();
    const store = localStorageStore("k", storage);
    const calls: string[] = [];
    store.onChange((t) => calls.push(t));

    handler({ key: "other", newValue: "{}" });
    expect(calls).toEqual([]);

    handler({
      key: "k",
      newValue: JSON.stringify({ token: "x", record: rec() }),
    });
    expect(store.token).toBe("x");
    expect(calls).toEqual(["x"]);
    expect(storage.data.has("k")).toBe(false);

    handler({ key: "k", newValue: null });
    expect(store.token).toBe("");
    expect(calls).toEqual(["x", ""]);
  });

  test("a throwing storage keeps the in-memory state and still fires onChange", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    const store = localStorageStore("k", {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
    });
    const calls: string[] = [];
    store.onChange((t) => calls.push(t));
    store.save("t", rec());
    expect(store.token).toBe("t");
    store.clear();
    expect(store.token).toBe("");
    expect(calls).toEqual(["t", ""]);
  });
});

describe("client auth store", () => {
  test("client defaults to memoryStore without window", () => {
    const client = createClient("http://a");
    client.authStore.save("t", null);
    expect(client.authStore.token).toBe("t");
  });

  test("client sends the store token as Authorization", async () => {
    const env = fakeEnv();
    const authStore = memoryStore();
    const client = createClientWith("http://a", { authStore }, env);
    expect(client.authStore).toBe(authStore);
    await client.send("x");
    authStore.save("tok", null);
    await client.send("x");
    expect(env.requests[0]!.headers.get("Authorization")).toBeNull();
    expect(env.requests[1]!.headers.get("Authorization")).toBe("tok");
  });
});
