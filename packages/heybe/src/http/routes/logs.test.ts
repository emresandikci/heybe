import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { App } from "../../app";
import { newAuthToken } from "../../auth/tokens";
import { internalRecords } from "../../records/internal";
import { testApp } from "../../test-app";
import { fakeClock } from "../../test-clock";
import { errorResponse } from "../errors";
import { LOG_META_KEY, loadAuth } from "../middlewares";
import { type Router, createEvent } from "../router";
import { createRouter } from "../server";

let clock: ReturnType<typeof fakeClock>;
let app: App;
let seq = 0;

beforeEach(() => {
  seq = 0;
  clock = fakeClock("2026-01-10T12:30:00Z");
  app = testApp({ now: clock.now, timers: clock.timers });
});

afterEach(() => app.close());

interface Row {
  id: string;
  level: number;
  message: string;
  data: string;
  created: string;
}

const logRows = async () => {
  await app.logger.flush();
  return app.auxDb
    .query<Row>("SELECT * FROM _logs ORDER BY rowid")
    .map((r) => ({ ...r, data: JSON.parse(r.data) }));
};

const insertLog = (level: number, created: string, data: object = {}) =>
  app.auxDb.write(() =>
    app.auxDb.run(
      "INSERT INTO _logs (id, level, message, data, created) VALUES (?, ?, 'm', ?, ?)",
      [`log${seq++}`, level, JSON.stringify(data), created],
    ),
  );

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
    as?: string;
    body?: unknown;
    router?: Router;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...opts.headers,
  };
  if (opts.as) headers.authorization = await tokenFor(opts.as);
  const req = new Request(`http://x${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const found = (opts.router ?? createRouter())
    .build()
    .match(method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params, "1.2.3.4", found.pattern);
  e.auth = loadAuth(app, req);
  try {
    return await found.run(e);
  } catch (err) {
    return errorResponse(err);
  }
}

describe("request logging", () => {
  test("a successful request is logged with PB's data keys", async () => {
    await call("GET", "/api/health?a=b%20c");
    const [row, ...rest] = await logRows();
    expect(rest).toEqual([]);
    expect(row!.level).toBe(0);
    expect(row!.message).toBe("GET /api/health?a=b c");
    expect(Object.keys(row!.data)).toEqual([
      "type",
      "execTime",
      "url",
      "method",
      "status",
      "referer",
      "userAgent",
      "auth",
      "userIP",
      "remoteIP",
    ]);
    expect({ ...row!.data, execTime: 0 }).toEqual({
      type: "request",
      execTime: 0,
      url: "/api/health?a=b%20c",
      method: "GET",
      status: 200,
      referer: "",
      userAgent: "",
      auth: "",
      userIP: "1.2.3.4",
      remoteIP: "1.2.3.4",
    });
  });

  test("a 404 and a thrown 400 are logged at level 8 with error and details", async () => {
    await call("GET", "/api/nope");
    await call("POST", "/api/collections/users/auth-with-password", {
      body: {},
    });
    const [notFound, bad] = await logRows();
    expect(notFound!.level).toBe(8);
    expect(notFound!.data).toMatchObject({
      error: "The requested resource wasn't found.",
      details: {},
      status: 404,
    });
    expect(bad!.level).toBe(8);
    expect(bad!.data.status).toBe(400);
    expect(bad!.data.error).toBeString();
    expect(bad!.data.details.identity.code).toBe("validation_required");
    expect(Object.keys(bad!.data).slice(0, 4)).toEqual([
      "type",
      "execTime",
      "error",
      "details",
    ]);
  });

  test("skip flag skips success but not errors", async () => {
    await call("GET", "/api/logs", { as: "_superusers" });
    expect(await logRows()).toEqual([]);
    const res = await call("GET", "/api/logs/nope", { as: "_superusers" });
    expect(res.status).toBe(404);
    const [row] = await logRows();
    expect(row!.data).toMatchObject({ url: "/api/logs/nope", status: 404 });
  });

  test("logIP false and logAuthId true", async () => {
    await app.settings.update({ logs: { logIP: false, logAuthId: true } });
    await call("GET", "/api/crons", { as: "_superusers" });
    const [row] = await logRows();
    const { auth, authId } = row!.data;
    expect(auth).toBe("_superusers");
    expect(authId).toBeString();
    expect(Object.keys(row!.data).slice(-2)).toEqual(["auth", "authId"]);
  });

  test("meta is logged after execTime, a bigint becomes a string", async () => {
    const router = createRouter();
    router.get("/meta", (e) => {
      e.set(LOG_META_KEY, { id: 12n, text: "x" });
      return e.json(200, {});
    });
    const res = await call("GET", "/meta", { router });
    expect(res.status).toBe(200);
    const [row] = await logRows();
    expect(row!.data.meta).toEqual({ id: "12", text: "x" });
    expect(Object.keys(row!.data).slice(0, 3)).toEqual([
      "type",
      "execTime",
      "meta",
    ]);
  });

  test("a 5000 char url is cut", async () => {
    const res = await call("GET", `/api/health?x=${"a".repeat(5000)}`);
    expect(res.status).toBe(200);
    const [row] = await logRows();
    expect(row!.data.url).toBe(`/api/health?x=${"a".repeat(3000 - 14)}...`);
    expect(row!.message).toBe(`GET ${row!.data.url}`);
  });

  test("authId is absent when logAuthId is false", async () => {
    await call("GET", "/api/crons", { as: "_superusers" });
    const [row] = await logRows();
    expect(row!.data.auth).toBe("_superusers");
    expect(row!.data).not.toHaveProperty("authId");
  });

  test("method, referer and userAgent are cut by bytes", async () => {
    const referer = "é".repeat(1500);
    const res = await call("GET", "/api/health", {
      headers: { referer, "user-agent": "u".repeat(2500) },
    });
    expect(res.status).toBe(200);
    const [row] = await logRows();
    expect(row!.data.referer).toBe(`${"é".repeat(1000)}...`);
    expect(row!.data.userAgent).toBe(`${"u".repeat(2000)}...`);
    const req = new Request("http://x/api/health");
    Object.defineProperty(req, "method", { value: "a".repeat(60) });
    const found = createRouter().build().match("GET", "/api/health")!;
    await found.run(createEvent(app, req, found.params));
    const [, long] = await logRows();
    expect(long!.data.method).toBe(`${"A".repeat(50)}...`);
  });

  test("success is not logged for realtime and oauth2 redirect", async () => {
    const realtime = await call("GET", "/api/realtime");
    expect(realtime.status).toBe(200);
    await realtime.body?.cancel();
    await call("GET", "/api/oauth2-redirect?state=x&code=y");
    await call("POST", "/api/oauth2-redirect", { body: {} });
    expect(await logRows()).toEqual([]);
  });

  test("maxDays 0 logs nothing", async () => {
    await app.settings.update({ logs: { maxDays: 0 } });
    await call("GET", "/api/nope");
    expect(await logRows()).toEqual([]);
  });

  test("a closed auxiliary db does not break the request", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    app.auxDb.close();
    const res = await call("GET", "/api/health");
    expect(res.status).toBe(200);
    await app.logger.flush();
    error.mockRestore();
  });
});

describe("logs API", () => {
  test("list filters on data, sorts, pages and skips the total", async () => {
    await insertLog(0, "2026-01-10 10:00:00.000Z", { status: 200 });
    await insertLog(8, "2026-01-10 11:00:00.000Z", { status: 404 });
    await insertLog(8, "2026-01-10 12:00:00.000Z", { status: 400 });
    const get = async (query: string) =>
      (await call("GET", `/api/logs?${query}`, { as: "_superusers" })).json();

    const filtered = await get(
      `filter=${encodeURIComponent("data.status>=400")}&sort=-created`,
    );
    expect(filtered).toMatchObject({
      page: 1,
      perPage: 30,
      totalItems: 2,
      totalPages: 1,
    });
    expect(
      filtered.items.map((i: { data: { status: number } }) => i.data.status),
    ).toEqual([400, 404]);
    expect(Object.keys(filtered.items[0])).toEqual([
      "id",
      "created",
      "data",
      "message",
      "level",
    ]);

    const paged = await get("sort=created&perPage=1&page=2&skipTotal=1");
    expect(paged).toMatchObject({
      page: 2,
      perPage: 1,
      totalItems: -1,
      totalPages: -1,
    });
    expect(paged.items.map((i: { id: string }) => i.id)).toEqual(["log1"]);

    const sorted = await get("sort=-data.status&fields=id");
    expect(sorted.items).toEqual([
      { id: "log1" },
      { id: "log2" },
      { id: "log0" },
    ]);
  });

  test("a bad filter, sort or page is 400", async () => {
    for (const query of [
      "filter=nope~1",
      "filter=data.",
      "sort=nope",
      "page=x",
      "skipTotal=maybe",
    ]) {
      const res = await call("GET", `/api/logs?${query}`, {
        as: "_superusers",
      });
      expect(res.status).toBe(400);
    }
  });

  test("the filter and sort limits match the records list", async () => {
    for (const query of [
      `filter=${encodeURIComponent(`message='${"a".repeat(3500)}'`)}`,
      `sort=${Array.from({ length: 9 }, () => "id").join(",")}`,
      `sort=${"a".repeat(256)}`,
    ]) {
      const res = await call("GET", `/api/logs?${query}`, {
        as: "_superusers",
      });
      expect(res.status).toBe(400);
    }
  });

  test("an empty string on a data path also matches NULL", async () => {
    await insertLog(0, "2026-01-10 10:00:00.000Z", { a: "" });
    await insertLog(0, "2026-01-10 10:01:00.000Z", {});
    await insertLog(0, "2026-01-10 10:02:00.000Z", { a: "x" });
    const ids = async (filter: string) =>
      (
        (await (
          await call("GET", `/api/logs?filter=${encodeURIComponent(filter)}`, {
            as: "_superusers",
          })
        ).json()) as { items: { id: string }[] }
      ).items.map((i) => i.id);
    expect(await ids("data.a=''")).toEqual(["log0", "log1"]);
    expect(await ids("data.a!=''")).toEqual(["log2"]);
  });

  test("stats group by hour", async () => {
    await insertLog(0, "2026-01-10 10:05:00.000Z");
    await insertLog(0, "2026-01-10 10:55:00.000Z");
    await insertLog(8, "2026-01-10 11:00:00.000Z");
    const stats = async (query = "") =>
      (
        await call("GET", `/api/logs/stats${query}`, { as: "_superusers" })
      ).json();
    expect(await stats()).toEqual([
      { date: "2026-01-10 10:00:00.000Z", total: 2 },
      { date: "2026-01-10 11:00:00.000Z", total: 1 },
    ]);
    expect(await stats("?filter=level>0")).toEqual([
      { date: "2026-01-10 11:00:00.000Z", total: 1 },
    ]);
    const bad = await call("GET", "/api/logs/stats?filter=nope~1", {
      as: "_superusers",
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toBe("Invalid filter format.");
  });

  test("view returns the log and a missing id is 404", async () => {
    await insertLog(4, "2026-01-10 10:00:00.000Z", { a: 1 });
    const ok = await call("GET", "/api/logs/log0", { as: "_superusers" });
    expect(await ok.json()).toEqual({
      id: "log0",
      created: "2026-01-10 10:00:00.000Z",
      data: { a: 1 },
      message: "m",
      level: 4,
    });
    const missing = await call("GET", "/api/logs/nope", { as: "_superusers" });
    expect(missing.status).toBe(404);
  });

  test("truncate deletes every log", async () => {
    await insertLog(0, "2026-01-10 10:00:00.000Z");
    const res = await call("DELETE", "/api/logs", { as: "_superusers" });
    expect(res.status).toBe(204);
    expect(await logRows()).toEqual([]);
  });

  test("guests get 401 and users 403 on every logs route", async () => {
    for (const [method, path] of [
      ["GET", "/api/logs"],
      ["GET", "/api/logs/stats"],
      ["GET", "/api/logs/x"],
      ["DELETE", "/api/logs"],
    ] as const) {
      expect((await call(method, path)).status).toBe(401);
      expect((await call(method, path, { as: "users" })).status).toBe(403);
    }
  });
});
