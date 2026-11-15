import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { App } from "../app";
import { newAuthToken } from "../auth/tokens";
import { internalRecords } from "../records/internal";
import type { RateLimitRule } from "../settings";
import { testApp } from "../test-app";
import { fakeClock } from "../test-clock";
import { errorResponse } from "./errors";
import { loadAuth, requireSameCollectionContextAuth } from "./middlewares";
import { collectionPathRateLimit, rateLimiters } from "./rate-limit";
import { createEvent } from "./router";
import { createRouter } from "./server";

const CRON_ID = "__pbRateLimitersCleanup__";

let clock: ReturnType<typeof fakeClock>;
let app: App;
let seq = 0;

beforeEach(async () => {
  clock = fakeClock("2026-01-10T12:30:00Z");
  app = testApp({ now: clock.now, timers: clock.timers });
  await app.settings.update({
    logs: { maxDays: 0 },
    batch: { enabled: true },
  });
  await app.collections.save({
    name: "posts",
    listRule: 'id != ""',
    viewRule: "",
    createRule: "",
    fields: [{ name: "title", type: "text" }],
  } as any);
});

afterEach(() => app.close());

const rule = (
  label: string,
  maxRequests: number,
  duration = 3,
  audience = "",
): RateLimitRule => ({ label, audience, duration, maxRequests });

const limit = (rules: RateLimitRule[], excludedIPs: string[] = []) =>
  app.settings.update({ rateLimits: { enabled: true, rules, excludedIPs } });

async function tokenFor(collection: string): Promise<string> {
  const records = internalRecords(app, collection);
  const created = await records.create({
    email: `a${seq++}@example.com`,
    password: "1234567890",
  });
  return newAuthToken(
    app,
    app.collections.find(collection)!,
    records.findRaw(created.id as string),
  );
}

async function call(
  method: string,
  path: string,
  opts: {
    token?: string;
    ip?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Response> {
  const req = new Request(`http://x${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: opts.token } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const found = createRouter()
    .build()
    .match(method, new URL(req.url).pathname)!;
  const e = createEvent(
    app,
    req,
    found.params,
    opts.ip ?? "1.2.3.4",
    found.pattern,
  );
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
  } catch (err) {
    return e.response ?? errorResponse(err);
  }
}

const statuses = async (n: number, send: () => Promise<Response>) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await send()).status);
  return out;
};

const health = (opts: Parameters<typeof call>[2] = {}) =>
  call("GET", "/api/health", opts);

describe("global rate limit", () => {
  test("the third request in a 2 per 3 s window answers 429 until the window resets", async () => {
    await limit([rule("/api/health", 2)]);
    expect(await statuses(3, health)).toEqual([200, 200, 429]);
    const res = await health();
    expect(await res.json()).toEqual({
      data: {},
      message: "Too Many Requests.",
      status: 429,
    });
    clock.advance(2999);
    expect((await health()).status).toBe(429);
    clock.advance(1);
    expect(await statuses(3, health)).toEqual([200, 200, 429]);
  });

  test("disabled rate limits never limit", async () => {
    await app.settings.update({
      rateLimits: { enabled: false, rules: [rule("/api/health", 1)] },
    });
    expect(await statuses(3, health)).toEqual([200, 200, 200]);
    expect(rateLimiters(app)).toBeUndefined();
  });

  test("superusers and excluded ips skip every limiter", async () => {
    await limit([rule("/api/", 1)], ["10.0.0.0/8"]);
    const token = await tokenFor("_superusers");
    expect(await statuses(3, () => health({ token }))).toEqual([200, 200, 200]);
    expect(await statuses(3, () => health({ ip: "10.1.2.3" }))).toEqual([
      200, 200, 200,
    ]);
    expect(await statuses(2, health)).toEqual([200, 429]);
  });

  test("@guest rules ignore auth users and @auth rules ignore guests", async () => {
    const token = await tokenFor("users");
    await limit([
      rule("/api/health", 1, 3, "@guest"),
      rule("GET /api/health", 2, 3, "@auth"),
    ]);
    expect(await statuses(2, health)).toEqual([200, 429]);
    expect(await statuses(3, () => health({ token }))).toEqual([200, 200, 429]);
  });

  test("behind a trusted proxy clients are keyed by their forwarded ip", async () => {
    await limit([rule("/api/health", 1)]);
    await app.settings.update({
      trustedProxy: { headers: ["x-forwarded-for"] },
    });
    const from = (ip: string) => () =>
      health({ headers: { "x-forwarded-for": ip } });
    expect(await statuses(2, from("5.5.5.5"))).toEqual([200, 429]);
    expect(await statuses(2, from("6.6.6.6"))).toEqual([200, 429]);
  });

  test("an untrusted X-Forwarded-For does not split a client", async () => {
    await limit([rule("/api/health", 1)]);
    expect(
      (await health({ headers: { "x-forwarded-for": "5.5.5.5" } })).status,
    ).toBe(200);
    expect(
      (await health({ headers: { "x-forwarded-for": "6.6.6.6" } })).status,
    ).toBe(429);
  });

  test("an empty client key is not limited", async () => {
    await limit([rule("/api/health", 1)]);
    expect(await statuses(3, () => health({ ip: "" }))).toEqual([
      200, 200, 200,
    ]);
  });

  test("a settings save resets the counters and removes the cleanup cron", async () => {
    await limit([rule("/api/health", 1, 60)]);
    const handlers = app.hooks.onSettingsReload.length;
    expect(app.scheduler.jobs().some((j) => j.id === CRON_ID)).toBe(false);
    expect(await statuses(2, health)).toEqual([200, 429]);
    expect(app.scheduler.jobs().some((j) => j.id === CRON_ID)).toBe(true);
    expect(app.hooks.onSettingsReload.length).toBe(handlers + 1);
    await app.settings.update({ meta: { appName: "Other" } });
    expect(app.scheduler.jobs().some((j) => j.id === CRON_ID)).toBe(false);
    expect(rateLimiters(app)).toBeUndefined();
    expect(app.hooks.onSettingsReload.length).toBe(handlers);
    expect(await statuses(2, health)).toEqual([200, 429]);
  });

  test("the cleanup cron drops clients idle for more than 1800 s after their window", async () => {
    await limit([rule("/api/health", 5, 60)]);
    await health({ ip: "1.1.1.1" });
    clock.advance(1000_000);
    await health({ ip: "2.2.2.2" });
    clock.advance(900_000);
    const job = app.scheduler.jobs().find((j) => j.id === CRON_ID)!;
    expect(job.expression).toBe("2 * * * *");
    await job.run();
    const clients = rateLimiters(app)!.get("/api/health")!.clients;
    expect([...clients.keys()]).toEqual(["2.2.2.2"]);
  });
});

describe("collection rate limits", () => {
  test("records list uses posts:list before *:list before /api/", async () => {
    await limit([rule("posts:list", 1), rule("*:list", 2), rule("/api/", 3)]);
    const list = (name: string) => () =>
      call("GET", `/api/collections/${name}/records`);
    expect(await statuses(2, list("posts"))).toEqual([200, 429]);
    expect(await statuses(3, list("users"))).toEqual([200, 200, 429]);
    expect(await statuses(4, health)).toEqual([200, 200, 200, 429]);
  });

  test("view, create, update and delete use their tags", async () => {
    const { id } = await app.records("posts").create({ title: "a" });
    await limit([
      rule("posts:view", 1),
      rule("posts:create", 1),
      rule("posts:update", 1),
      rule("posts:delete", 1),
    ]);
    const base = "/api/collections/posts/records";
    const view = () => call("GET", `${base}/${id}`);
    const create = () => call("POST", base, { body: { title: "b" } });
    const update = () => call("PATCH", `${base}/${id}`, { body: {} });
    const remove = () => call("DELETE", `${base}/${id}`);
    expect(await statuses(2, view)).toEqual([200, 429]);
    expect(await statuses(2, create)).toEqual([200, 429]);
    expect((await update()).status).not.toBe(429);
    expect((await update()).status).toBe(429);
    expect((await remove()).status).not.toBe(429);
    expect((await remove()).status).toBe(429);
  });

  test("records routes skip the global limiter", async () => {
    await limit([rule("/api/", 2)]);
    expect(
      await statuses(2, () => call("GET", "/api/collections/posts/records")),
    ).toEqual([200, 200]);
    expect(await statuses(3, health)).toEqual([200, 200, 429]);
  });

  test("batch sub-requests are limited per collection with their own counter, like PB", async () => {
    await limit([rule("posts:create", 1, 60)]);
    const create = {
      method: "POST",
      url: "/api/collections/posts/records",
      body: { title: "a" },
    };
    const res = await call("POST", "/api/batch", {
      body: { requests: [create, create] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      data: {
        requests: {
          "1": {
            code: "batch_request_failed",
            message: "Batch request failed.",
            response: { data: {}, message: "Too Many Requests.", status: 429 },
          },
        },
      },
      message: "Batch transaction failed.",
      status: 400,
    });
    expect(
      (await call("POST", "/api/collections/posts/records", { body: {} }))
        .status,
    ).toBe(200);
  });

  test("requestOTP tag on its route", async () => {
    await limit([rule("users:requestOTP", 1)]);
    const send = () =>
      call("POST", "/api/collections/users/request-otp", {
        body: { email: "a@example.com" },
      });
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).toBe(429);
  });

  test("auth-with-password counts against *:auth", async () => {
    await limit([rule("*:auth", 1)]);
    const send = () =>
      call("POST", "/api/collections/users/auth-with-password", {
        body: { identity: "a@example.com", password: "1234567890" },
      });
    expect(await statuses(2, send)).toEqual([400, 429]);
  });

  test("file download uses the file tag", async () => {
    await limit([rule("*:file", 1)]);
    const send = () => call("GET", "/api/files/posts/abc/a.txt");
    expect(await statuses(2, send)).toEqual([404, 429]);
  });

  test("a missing collection answers PB's 404 even with rate limits disabled", async () => {
    for (const path of [
      "/api/files/missing/abc/a.txt",
      "/api/collections/missing/auth-methods",
    ]) {
      const res = await call("GET", path);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { message: string }).message).toBe(
        "Missing or invalid collection context.",
      );
    }
  });

  test("renaming a collection renames its rules", async () => {
    await limit([rule("posts:list", 1), rule("*:list", 2)]);
    const { id } = app.collections.find("posts")!;
    await app.collections.save({ id, name: "articles" } as any);
    expect(app.settings.get().rateLimits.rules.map((r) => r.label)).toEqual([
      "articles:list",
      "*:list",
    ]);
  });
});

describe("randomized list throttle", () => {
  const search = (token?: string) =>
    call("GET", '/api/collections/posts/records?filter=title="nope"', {
      token,
    });

  test("the fourth empty filtered list in 3 s waits below 500 ms", async () => {
    expect(await statuses(3, () => search())).toEqual([200, 200, 200]);
    expect(clock.pending()).toBe(0);
    const scheduled = clock.scheduled();
    let settled = false;
    const fourth = search().then((res) => {
      settled = true;
      return res;
    });
    await scheduled;
    expect(clock.pending()).toBe(1);
    expect(settled).toBe(false);
    clock.advance(499);
    const res = await fourth;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  });

  test("superusers, empty filters and found items never wait", async () => {
    await app.records("posts").create({ title: "yes" });
    const token = await tokenFor("_superusers");
    await statuses(5, () => search(token));
    await statuses(5, () => call("GET", "/api/collections/posts/records"));
    await statuses(5, () =>
      call("GET", '/api/collections/posts/records?filter=title="yes"'),
    );
    expect(clock.pending()).toBe(0);
  });
});

test("collection path middlewares run no _collections query once the cache is warm", async () => {
  const token = await tokenFor("users");
  const req = new Request("http://x", { headers: { authorization: token } });
  const e = createEvent(app, req, { collection: "users" });
  e.auth = loadAuth(app, req);
  const middlewares = [
    collectionPathRateLimit("collection", "authRefresh"),
    requireSameCollectionContextAuth(),
  ];
  for (const m of middlewares) await m.fn(e);
  const get = spyOn(app.db, "get");
  const query = spyOn(app.db, "query");
  try {
    for (const m of middlewares) await m.fn(e);
    const sql = [...get.mock.calls, ...query.mock.calls].map(([s]) => s);
    expect(sql.filter((s) => s.includes("_collections"))).toEqual([]);
  } finally {
    get.mockRestore();
    query.mockRestore();
  }
});
