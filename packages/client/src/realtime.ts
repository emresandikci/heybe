import type { AuthRecord, AuthStore } from "./auth-store.js";
import type { Env } from "./env.js";
import { HeybeError } from "./error.js";
import { tokenPayload } from "./jwt.js";
import type { SendOptions } from "./send.js";
import { readFrames, type Frame } from "./sse.js";

export interface TopicOptions {
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface Realtime {
  readonly clientId: string;
  readonly isConnected: boolean;
  onDisconnect?: (activeTopics: string[]) => void;
  subscribe(
    topic: string,
    fn: (data: any) => void,
    opts?: TopicOptions,
  ): Promise<() => Promise<void>>;
  unsubscribe(topic?: string): Promise<void>;
  unsubscribeByPrefix(prefix: string): Promise<void>;
}

interface RealtimeDeps {
  env: Env;
  authStore: AuthStore;
  buildURL(path: string): string;
  send(path: string, opts: SendOptions): Promise<unknown>;
  cancelRequest(key: string): void;
}

type Listener = (data: any) => void;
type Pending = { resolve: () => void; reject: (err: unknown) => void };

const CONNECT_TIMEOUT = 15000;
const RECONNECT_DELAYS = [200, 300, 500, 1000, 1200, 1500, 2000];

// what the server compares on resubmit: the token's own ids, the record's only when the token lacks them
function identity(token: string, record: AuthRecord | null): string {
  if (!token) return "";
  const p = tokenPayload(token);
  return `${p.collectionId ?? record?.collectionId}/${p.id ?? record?.id}`;
}

function parse(data: string): any {
  try {
    return JSON.parse(data) || {};
  } catch {
    return {};
  }
}

export function createRealtime(deps: RealtimeDeps): Realtime {
  const { env } = deps;
  const subs = new Map<string, Listener[]>();
  let clientId = "";
  let stream: AbortController | null = null;
  let lastSent: string[] = [];
  let connectTimer: unknown;
  let reconnectTimer: unknown;
  let attempts = 0;
  let restarting = false;
  let pendingConnects: Pending[] = [];
  let pendingSubmits: Pending[] = [];
  let processing = false;
  let token = deps.authStore.token;
  let authId = identity(token, deps.authStore.record);
  let sentToken = "";

  const cancelKey = () => `realtime_${clientId}`;
  const keys = () => [...subs.keys()].filter((k) => subs.get(k)!.length);
  const hasUnsent = () => {
    const latest = keys();
    return (
      latest.length !== lastSent.length ||
      latest.some((k) => !lastSent.includes(k))
    );
  };
  const byPrefix = (prefix: string) =>
    [...subs.keys()].filter((k) => (k + "?").startsWith(prefix));
  const byTopic = (topic: string) =>
    byPrefix(topic.includes("?") ? topic : topic + "?");

  const settleConnects = (err?: unknown) => {
    const pending = pendingConnects;
    pendingConnects = [];
    for (const p of pending) err ? p.reject(err) : p.resolve();
  };

  async function sendSubscriptions(): Promise<void> {
    if (!keys().length) return disconnect();
    if (!clientId) return;
    if (!hasUnsent() && sentToken === deps.authStore.token) return;
    lastSent = keys();
    try {
      await deps.send("/api/realtime", {
        method: "POST",
        body: { clientId, subscriptions: lastSent },
        requestKey: cancelKey(),
      });
      // read after the POST: a refresh run by its own beforeSend is already sent
      sentToken = deps.authStore.token;
    } catch (err: any) {
      if (!err?.isAbort) throw err;
    }
  }

  async function processSubmits(): Promise<void> {
    if (processing || !pendingSubmits.length) return;
    const pending = pendingSubmits;
    pendingSubmits = [];
    processing = true;
    try {
      await sendSubscriptions();
      for (const p of pending) p.resolve();
    } catch (err) {
      for (const p of pending) p.reject(err);
    } finally {
      processing = false;
      if (pendingSubmits.length) await processSubmits();
    }
  }

  function submit(): Promise<void> {
    return new Promise((resolve, reject) => {
      pendingSubmits.push({ resolve, reject });
      if (pendingSubmits.length === 1) Promise.resolve().then(processSubmits);
    });
  }

  function connect(): Promise<void> {
    if (attempts > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      pendingConnects.push({ resolve, reject });
      if (pendingConnects.length === 1 && !stream)
        Promise.resolve().then(initConnect);
    });
  }

  function initConnect() {
    disconnect(true);
    connectTimer = env.setTimeout(
      () => connectError(new Error("Realtime connect took too long.")),
      CONNECT_TIMEOUT,
    );
    const controller = new AbortController();
    stream = controller;
    const current = () => stream === controller;
    env
      .fetch(deps.buildURL("/api/realtime"), {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      })
      .then((res) => {
        if (!res.ok || !res.body) {
          void res.body?.cancel().catch(() => {});
          throw new Error("Failed to establish realtime connection.");
        }
        return readFrames(
          res.body,
          (f) => current() && onFrame(f),
          controller.signal,
        );
      })
      .then(
        () => current() && connectError(new Error("Realtime stream ended.")),
        (err) => current() && connectError(err),
      );
  }

  function onFrame(f: Frame) {
    if (f.event === "PB_CONNECT") return onConnect(f);
    for (const fn of [...(subs.get(f.event) ?? [])]) fn(parse(f.data));
  }

  function onConnect(f: Frame) {
    const conn = stream;
    clientId = f.id;
    lastSent = [];
    submit()
      .then(async () => {
        if (stream !== conn) return;
        for (let i = 3; hasUnsent() && i > 0; i--) await submit();
        settleConnects();
        attempts = 0;
        restarting = false;
        env.clearTimeout(reconnectTimer);
        env.clearTimeout(connectTimer);
        for (const key of byTopic("PB_CONNECT"))
          for (const fn of [...subs.get(key)!]) fn(parse(f.data));
        if (hasUnsent()) await submit();
      })
      .catch((err) => {
        if (stream !== conn) return;
        clientId = "";
        lastSent = [];
        connectError(err);
      });
  }

  function connectError(err: unknown) {
    env.clearTimeout(connectTimer);
    env.clearTimeout(reconnectTimer);
    if (!clientId && !attempts && !restarting) {
      settleConnects(
        err instanceof HeybeError ? err : new HeybeError({ cause: err }),
      );
      disconnect();
      return;
    }
    disconnect(true);
    const delay =
      RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)]!;
    attempts++;
    reconnectTimer = env.setTimeout(initConnect, delay);
  }

  function disconnect(fromReconnect = false) {
    if (clientId) realtime.onDisconnect?.([...subs.keys()]);
    env.clearTimeout(connectTimer);
    env.clearTimeout(reconnectTimer);
    deps.cancelRequest(cancelKey());
    stream?.abort();
    stream = null;
    clientId = "";
    lastSent = [];
    if (!fromReconnect) {
      attempts = 0;
      restarting = false;
      settleConnects();
    }
  }

  function remove(matching: string[], listener?: Listener) {
    for (const key of matching) {
      const list = subs.get(key);
      if (!list) continue;
      const rest = listener ? list.filter((fn) => fn !== listener) : [];
      if (rest.length) subs.set(key, rest);
      else subs.delete(key);
    }
  }

  deps.authStore.onChange((t, record) => {
    if (t === token) return;
    const sameAuth = identity(t, record) === authId;
    token = t;
    authId = identity(t, record);
    if (!clientId) return;
    if (sameAuth) return void submit().catch(() => {});
    restarting = true;
    initConnect();
  });

  const realtime: Realtime = {
    get clientId() {
      return clientId;
    },
    get isConnected() {
      return !!stream && !!clientId && !pendingConnects.length;
    },
    async subscribe(topic, fn, opts) {
      if (!topic) throw new Error("topic must be set.");
      let key = topic;
      if (opts)
        key +=
          (topic.includes("?") ? "&" : "?") +
          "options=" +
          encodeURIComponent(
            JSON.stringify({ query: opts.query, headers: opts.headers }),
          );
      const listener: Listener = (data) => fn(data);
      const list = subs.get(key) ?? [];
      list.push(listener);
      subs.set(key, list);
      if (!realtime.isConnected) await connect();
      else if (list.length === 1) await submit();
      return () => {
        remove(byTopic(topic), listener);
        return submit();
      };
    },
    async unsubscribe(topic) {
      remove(topic ? byTopic(topic) : [...subs.keys()]);
      await submit();
    },
    async unsubscribeByPrefix(prefix) {
      const matching = byPrefix(prefix);
      if (!matching.length) return;
      remove(matching);
      await submit();
    },
  };
  return realtime;
}
