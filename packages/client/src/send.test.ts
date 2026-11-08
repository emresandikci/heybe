import { afterEach, describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { HeybeError } from "./error.js";
import { buildURL, createSender, serializeQuery, toBody } from "./send.js";
import { fakeEnv } from "./test-env.js";

const never = () => new Promise<Response>(() => {});

function setup(opts: { autoCancel?: boolean } = {}) {
  const env = fakeEnv();
  const client = createClientWith("http://a", opts, env);
  return { env, client };
}

async function rejection(p: Promise<unknown>): Promise<HeybeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HeybeError);
    return err as HeybeError;
  }
  throw new Error("expected a rejection");
}

describe("buildURL", () => {
  const g = globalThis as { location?: unknown };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "location", saved);
    else delete g.location;
  });

  test("builds URLs with one slash", () => {
    expect(buildURL("http://a/", "/api/x")).toBe("http://a/api/x");
    expect(buildURL("http://a", "api/x")).toBe("http://a/api/x");
  });

  test("relative base uses location", () => {
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://site.test", pathname: "/app/page" },
      configurable: true,
    });
    expect(buildURL("/", "/api/x")).toBe("https://site.test/api/x");
    expect(buildURL("/sub", "api/x")).toBe("https://site.test/sub/api/x");
    expect(buildURL("pb", "api/x")).toBe("https://site.test/app/page/pb/api/x");
  });
});

test("serializes query like PB", () => {
  expect(
    serializeQuery({
      a: [1, 2],
      d: new Date("2026-01-02T03:04:05.000Z"),
      o: { x: 1 },
      n: null,
      u: undefined,
    }),
  ).toBe("a=1&a=2&d=2026-01-02%2003%3A04%3A05.000Z&o=%7B%22x%22%3A1%7D");
});

test("JSON body and headers", async () => {
  const env = fakeEnv();
  const { send } = createSender({
    url: "http://a",
    lang: "en-US",
    env,
    token: () => "tok",
    autoCancel: () => true,
  });
  await send("/api/x", { method: "POST", body: { a: 1 }, query: { q: "v" } });
  const [req] = env.requests;
  expect(req!.method).toBe("POST");
  expect(req!.url).toBe("http://a/api/x?q=v");
  expect(req!.body).toBe('{"a":1}');
  expect(req!.headers.get("content-type")).toBe("application/json");
  expect(req!.headers.get("accept-language")).toBe("en-US");
  expect(req!.headers.get("authorization")).toBe("tok");
});

test("caller Authorization wins", async () => {
  const env = fakeEnv();
  const { send } = createSender({
    url: "http://a",
    lang: "en-US",
    env,
    token: () => "tok",
    autoCancel: () => true,
  });
  await send("/api/x", { headers: { authorization: "mine" } });
  expect(env.requests[0]!.headers.get("authorization")).toBe("mine");
});

test("FormData body has no content-type set by us", async () => {
  const { env, client } = setup();
  await client.send("/api/x", {
    method: "POST",
    body: { f: new File(["x"], "n.png") },
  });
  const [req] = env.requests;
  expect(req!.body).toBeInstanceOf(FormData);
  expect(req!.headers.has("content-type")).toBe(false);
});

test("toBody multipart shape", () => {
  const file = new File(["x"], "n.png");
  const form = toBody({
    title: "a",
    meta: { x: 1 },
    files: ["old.png", file],
    skip: undefined,
  });
  expect(form).toBeInstanceOf(FormData);
  const entries = [...(form as FormData).entries()];
  expect(entries.map(([k]) => k)).toEqual([
    "title",
    "@jsonPayload",
    "files",
    "files",
  ]);
  expect(entries[0]![1]).toBe("a");
  expect(entries[1]![1]).toBe('{"meta":{"x":1}}');
  expect(entries[2]![1]).toBe("old.png");
  expect(entries[3]![1]).toBeInstanceOf(File);
  expect(entries[3]![1]).toHaveProperty("name", "n.png");
});

test("toBody puts null next to a file into @jsonPayload", () => {
  const form = toBody({ n: null, f: new File(["x"], "n.png") }) as FormData;
  expect(form.getAll("@jsonPayload")).toEqual(['{"n":null}']);
  expect(form.has("n")).toBe(false);
});

test("raw bodies pass through without a JSON content-type", async () => {
  const { env, client } = setup();
  const blob = new Blob(["x"]);
  const params = new URLSearchParams("a=1");
  for (const body of ["raw", blob, params])
    await client.send("/api/x", { method: "POST", body, requestKey: null });
  expect(env.requests.map((r) => r.body)).toEqual(["raw", blob, params]);
  for (const r of env.requests)
    expect(r.headers.get("content-type")).not.toBe("application/json");
});

test("null body sends no body", async () => {
  const { env, client } = setup();
  await client.send("/api/x", { method: "POST", body: null });
  expect(env.requests[0]!.body).toBeUndefined();
  expect(env.requests[0]!.headers.get("content-type")).toBe("application/json");
});

test("auto-cancel aborts the previous same-key request", async () => {
  const { env, client } = setup();
  let calls = 0;
  env.respond(() => (++calls === 1 ? never() : Response.json({ ok: true })));
  const first = client.send("/api/x");
  const second = client.send("/api/x");
  const err = await rejection(first);
  expect(err.isAbort).toBe(true);
  expect(err.status).toBe(0);
  expect(err.message).toBe(
    "The request was aborted (most likely autocancelled).",
  );
  expect(await second).toEqual({ ok: true });
});

test("requestKey null opts out", async () => {
  const { env, client } = setup();
  let calls = 0;
  env.respond(() => Response.json({ n: ++calls }));
  const results = await Promise.all([
    client.send("/api/x", { requestKey: null }),
    client.send("/api/x", { requestKey: null }),
  ]);
  expect(results).toEqual([{ n: 1 }, { n: 2 }]);
});

test("autoCancel false opts out", async () => {
  const { env, client } = setup({ autoCancel: false });
  let calls = 0;
  env.respond(() => Response.json({ n: ++calls }));
  const results = await Promise.all([
    client.send("/api/x"),
    client.send("/api/x"),
  ]);
  expect(results).toEqual([{ n: 1 }, { n: 2 }]);
});

test("cancelAllRequests aborts all pending", async () => {
  const { env, client } = setup();
  env.respond(never);
  const a = client.send("/api/a");
  const b = client.send("/api/b", { requestKey: "k" });
  client.cancelAllRequests();
  expect((await rejection(a)).isAbort).toBe(true);
  expect((await rejection(b)).isAbort).toBe(true);
});

test("cancelRequest aborts only that key", async () => {
  const { env, client } = setup();
  let calls = 0;
  env.respond(() => (++calls === 1 ? never() : Response.json({ ok: true })));
  const a = client.send("/api/a", { requestKey: "k" });
  const b = client.send("/api/b");
  client.cancelRequest("k");
  expect((await rejection(a)).isAbort).toBe(true);
  expect(await b).toEqual({ ok: true });
});

test("caller signal aborts the request", async () => {
  for (const autoCancel of [true, false]) {
    const { env, client } = setup({ autoCancel });
    env.respond(never);
    const caller = new AbortController();
    const p = client.send("/api/x", { signal: caller.signal });
    caller.abort();
    expect((await rejection(p)).isAbort).toBe(true);
  }
});

test("already aborted caller signal rejects with isAbort", async () => {
  const { client } = setup();
  const err = await rejection(
    client.send("/api/x", { signal: AbortSignal.abort() }),
  );
  expect(err.isAbort).toBe(true);
});

test("non-JSON error body gives an empty response", async () => {
  const { env, client } = setup();
  env.respond(() => new Response("<html>bad</html>", { status: 502 }));
  const err = await rejection(client.send("/api/x"));
  expect(err.status).toBe(502);
  expect(err.response).toEqual({});
  expect(err.message).toBe("Something went wrong.");
});

test("error response maps to HeybeError", async () => {
  const { env, client } = setup();
  const body = { status: 400, message: "Bad thing.", data: { a: 1 } };
  env.respond(() => Response.json(body, { status: 400 }));
  const err = await rejection(client.send("/api/x"));
  expect(err.status).toBe(400);
  expect(err.response).toEqual(body);
  expect(err.message).toBe("Bad thing.");
  expect(err.isAbort).toBe(false);
  expect(err.url).toBe("http://a/api/x");
});

test('network error gives status 0 and "Something went wrong."', async () => {
  const { env, client } = setup();
  const cause = new TypeError("fetch failed");
  env.respond(() => {
    throw cause;
  });
  const err = await rejection(client.send("/api/x"));
  expect(err.status).toBe(0);
  expect(err.isAbort).toBe(false);
  expect(err.message).toBe("Something went wrong.");
  expect(err.response).toEqual({});
  expect(err.cause).toBe(cause);
});

test("204 resolves undefined", async () => {
  const { env, client } = setup();
  env.respond(() => new Response(null, { status: 204 }));
  expect(await client.send("/api/x", { method: "DELETE" })).toBeUndefined();
});
