import type { App } from "../app";
import type { Collection } from "../collections/model";
import { isIpInList } from "../ip";
import { type RateLimitRule, findRateLimitRule } from "../settings";
import type { Middleware, RequestEvent } from "./router";

// Port of PB apis/middlewares_rate_limit.go.

export const RATE_LIMIT_ID = "hbRateLimit";
export const RATE_LIMIT_PRIORITY = -1000;
const CLEANUP_CRON_ID = "__hbRateLimitersCleanup__";
const SETTINGS_HOOK_ID = "__hbRateLimitersSettingsHook__";
const MIN_DELETE_INTERVAL = 1800;

interface Limiter {
  maxAllowed: number;
  interval: number;
  // fixed windows per client key, in unix seconds
  clients: Map<string, { start: number; available: number }>;
}

const stores = new WeakMap<App, Map<string, Limiter>>();

export const rateLimiters = (app: App) => stores.get(app);

const unixNow = (app: App) => Math.floor(app.now().getTime() / 1000);

function initStore(app: App): Map<string, Limiter> {
  const store = new Map<string, Limiter>();
  stores.set(app, store);
  app.scheduler.add(CLEANUP_CRON_ID, "2 * * * *", () => {
    const now = unixNow(app);
    for (const limiter of store.values())
      for (const [key, client] of limiter.clients)
        if (now - (client.start + limiter.interval) > MIN_DELETE_INTERVAL)
          limiter.clients.delete(key);
  });
  app.hooks.onSettingsReload.bind(
    async (e) => {
      await e.next();
      app.hooks.onSettingsReload.unbind(SETTINGS_HOOK_ID);
      app.scheduler.remove(CLEANUP_CRON_ID);
      stores.delete(app);
    },
    { id: SETTINGS_HOOK_ID },
  );
  return store;
}

function consume(limiter: Limiter, key: string, now: number): boolean {
  let client = limiter.clients.get(key);
  if (!client) {
    client = { start: 0, available: 0 };
    limiter.clients.set(key, client);
  }
  if (now - client.start >= limiter.interval) {
    client.available = limiter.maxAllowed;
    client.start = now;
  }
  if (client.available === 0) return false;
  client.available--;
  return true;
}

// Throws 429 when the client is over the rule; it does not check rateLimits.enabled (PB).
export function checkRateLimit(
  e: RequestEvent,
  id: string,
  rule: RateLimitRule,
): void {
  if (rule.audience === "@guest" && e.auth) return;
  if (rule.audience === "@auth" && !e.auth) return;
  const store = stores.get(e.app) ?? initStore(e.app);
  let limiter = store.get(id);
  if (!limiter) {
    limiter = {
      maxAllowed: rule.maxRequests,
      interval: rule.duration,
      clients: new Map(),
    };
    store.set(id, limiter);
  }
  const key = e.realIp();
  if (key === "") {
    e.app.logger.warn("Empty rate limit client key");
    return;
  }
  if (!consume(limiter, key, unixNow(e.app))) throw e.tooManyRequestsError();
}

function skipRateLimit(e: RequestEvent): boolean {
  const { enabled, excludedIPs } = e.app.settings.current().rateLimits;
  return (
    !enabled ||
    e.hasSuperuserAuth() ||
    (excludedIPs.length > 0 && isIpInList(excludedIPs, e.realIp()))
  );
}

const GUEST_AUDIENCE = ["", "@guest"];
const AUTH_AUDIENCE = ["", "@auth"];

const audience = (e: RequestEvent) => (e.auth ? AUTH_AUDIENCE : GUEST_AUDIENCE);

function defaultLabels(e: RequestEvent): string[] {
  let path = new URL(e.req.url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  return [`${e.req.method} ${path}`, path];
}

export function rateLimit(): Middleware {
  return {
    id: RATE_LIMIT_ID,
    priority: RATE_LIMIT_PRIORITY,
    fn: (e) => {
      if (skipRateLimit(e)) return e.next();
      const rule = findRateLimitRule(
        e.app.settings.current().rateLimits,
        defaultLabels(e),
        audience(e),
      );
      if (rule) checkRateLimit(e, rule.label + rule.audience, rule);
      return e.next();
    },
  };
}

// Labels "<name>:<tag>" for each tag, then "*:<tag>", then the path labels.
export function checkCollectionRateLimit(
  e: RequestEvent,
  c: Collection,
  ...tags: string[]
): void {
  if (skipRateLimit(e)) return;
  const labels = [
    ...tags.map((tag) => `${c.name}:${tag}`),
    ...tags.map((tag) => `*:${tag}`),
    ...defaultLabels(e),
  ];
  const rule = findRateLimitRule(
    e.app.settings.current().rateLimits,
    labels,
    audience(e),
  );
  if (rule)
    checkRateLimit(e, c.id + e.pattern + tags.join("") + rule.audience, rule);
}

export function collectionPathRateLimit(
  param: string,
  ...tags: string[]
): Middleware {
  return {
    id: RATE_LIMIT_ID,
    priority: RATE_LIMIT_PRIORITY,
    fn: (e) => {
      const c = e.app.collections.findCached(e.params[param] ?? "");
      if (!c) throw e.notFoundError("Missing or invalid collection context.");
      checkCollectionRateLimit(e, c, ...tags);
      return e.next();
    },
  };
}

export function randomizedThrottle(app: App, softMaxMs: number): Promise<void> {
  const ms = crypto.getRandomValues(new Uint32Array(1))[0]! % softMaxMs;
  return new Promise((resolve) => app.timers.setTimeout(resolve, ms));
}
