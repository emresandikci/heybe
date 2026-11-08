import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {} from "../app";
import { testApp } from "../test-app";
import { FilterError } from "../filter/parse";
import { RecordRequestEvent } from "../hooks/events";
import { Hook } from "../hooks/hook";
import { NotFoundError, ValidationError } from "../util";
import { Route } from "../extend/route";
import { ApiError, errorResponse, logUnexpected, toApiError } from "./errors";
import { DEFAULT_MAX_BODY_SIZE, bodyLimit } from "./middlewares";
import {
  type RequestEvent,
  Router,
  createEvent,
  markListResult,
} from "./router";
import { parseHttpAddr, serve, serveOptions } from "./server";

const app = testApp();
afterAll(() => app.close());

const ok = () => new Response("ok");

async function call(router: Router, method: string, path: string) {
  const req = new Request(`http://x${path}`, { method });
  const found = router.build().match(method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  try {
    return await found.run(e);
  } catch (err) {
    return e.response ?? errorResponse(err);
  }
}

const text = async (router: Router, method: string, path: string) =>
  (await call(router, method, path)).text();

// Middleware that records its name in the response chain.
const trace =
  (name: string, log: string[]) =>
  (e: RequestEvent): unknown => {
    log.push(name);
    return e.next();
  };

describe("Router", () => {
  test("literal segments win over params regardless of registration order", async () => {
    const router = new Router();
    router.get("/api/collections/{collection}", () => new Response("param"));
    router.get(
      "/api/collections/meta/scaffolds",
      () => new Response("literal"),
    );
    router.get("/api/collections/{collection}/records", ok);
    expect(await text(router, "GET", "/api/collections/meta/scaffolds")).toBe(
      "literal",
    );
    expect(await text(router, "GET", "/api/collections/users")).toBe("param");
  });

  test("wildcard catch-all never shadows specific routes", async () => {
    const router = new Router();
    router.get("/{path...}", (e) => e.string(200, e.params.path!));
    router.get("/api/health", ok);
    expect(await text(router, "GET", "/api/health")).toBe("ok");
    expect(await text(router, "GET", "/api/nope/a%20b")).toBe("api/nope/a b");
  });

  test("unmatched requests run the global middlewares and answer PB's 404", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use(trace("global", log));
    router.get("/a", ok);
    const res = await call(router, "POST", "/a");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      status: 404,
      message: "The requested resource wasn't found.",
      data: {},
    });
    expect(log).toEqual(["global"]);
  });

  test("group prefixes nest and middlewares run global, group, nested group, route", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use(trace("global", log));
    const api = router.group("/api").use(trace("api", log));
    const v1 = api.group("/v1").use(trace("v1", log));
    v1.get(
      "/items/{id}",
      (e) => e.string(200, e.params.id!),
      trace("route", log),
    );
    expect(await text(router, "GET", "/api/v1/items/7")).toBe("7");
    expect(log).toEqual(["global", "api", "v1", "route"]);
  });

  test("priority beats nesting", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use({ fn: trace("global", log), priority: 5 });
    router
      .group("/g")
      .use({ fn: trace("group", log), priority: 1 })
      .get("/x", ok, { fn: trace("route", log), priority: -1 });
    await call(router, "GET", "/g/x");
    expect(log).toEqual(["route", "group", "global"]);
  });

  test("a middleware with the same id replaces the inherited one", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use({ id: "auth", fn: trace("global", log) });
    router.get("/x", ok, { id: "auth", fn: trace("route", log) });
    await call(router, "GET", "/x");
    expect(log).toEqual(["route"]);
  });

  test("unbind on a group or route excludes inherited middlewares with that id", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use(
      { id: "a", fn: trace("a", log) },
      { id: "b", fn: trace("b", log) },
    );
    const group = router.group("/g");
    group.get("/one", ok);
    group.get("/two", ok).unbind("b");
    group.unbind("a");
    router.get("/three", ok);
    await call(router, "GET", "/g/one");
    expect(log).toEqual(["b"]);
    log.length = 0;
    await call(router, "GET", "/g/two");
    expect(log).toEqual([]);
    log.length = 0;
    await call(router, "GET", "/three");
    expect(log).toEqual(["a", "b"]);
  });

  test("use after unbind binds the id again", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use({ id: "a", fn: trace("global", log) });
    router
      .get("/x", ok)
      .unbind("a")
      .use({ id: "a", fn: trace("route", log) });
    await call(router, "GET", "/x");
    expect(log).toEqual(["route"]);
  });

  test("registering the same method and path twice throws", () => {
    const router = new Router();
    router.get("/api/items/{id}", ok);
    router.post("/api/items/{id}", ok);
    expect(() => router.group("/api").get("/items/{key}", ok)).toThrow(
      "heybe: route GET /api/items/{key} is already registered",
    );
  });

  test("a returned Response or a response helper sets e.response, ?fields= picks JSON", async () => {
    const router = new Router();
    let seen: Response | null = null;
    router.use(async (e) => {
      await e.next();
      seen = e.response;
    });
    router.get("/json", (e) => {
      e.json(200, { a: 1, b: { c: 2, d: 3 } });
    });
    router.get("/raw", () => new Response("raw", { status: 201 }));
    const res = await call(router, "GET", "/json?fields=b.c");
    expect(await res.json()).toEqual({ b: { c: 2 } });
    expect(seen!).toBe(res);
    expect((await call(router, "GET", "/raw")).status).toBe(201);
  });

  test("redirect outside 300-399 is PB's 500", async () => {
    const router = new Router();
    router.get("/r", (e) => e.redirect(200, "/x"));
    const res = await call(router, "GET", "/r");
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toBe(
      "Invalid redirect status code.",
    );
  });

  test("a response set before an error wins, like PB's written check", async () => {
    const router = new Router();
    router.get("/x", (e) => {
      e.string(200, "done");
      throw new Error("late");
    });
    const res = await call(router, "GET", "/x");
    expect(await res.text()).toBe("done");
  });
});

describe("Go ServeMux patterns", () => {
  test("{$} matches only the path ending there", async () => {
    const router = new Router();
    router.get("/{$}", () => new Response("root"));
    router.get("/a/{$}", () => new Response("a"));
    expect(await text(router, "GET", "/")).toBe("root");
    expect(await text(router, "GET", "/a/")).toBe("a");
    expect((await call(router, "GET", "/a/b")).status).toBe(404);
  });

  test("a trailing slash matches the subtree and GET / is a GET catch-all", async () => {
    const router = new Router();
    router.get("/static/", () => new Response("static"));
    router.get("/", () => new Response("all"));
    expect(router.hasRoute("GET", "/{path...}")).toBe(true);
    expect(await text(router, "GET", "/static/a/b.css")).toBe("static");
    expect(await text(router, "GET", "/static/")).toBe("static");
    expect(await text(router, "GET", "/nope")).toBe("all");
    expect((await call(router, "POST", "/nope")).status).toBe(404);
  });

  test("a single wildcard never matches an empty segment", async () => {
    const router = new Router();
    router.get("/hello/{name}", (e) => e.string(200, e.params.name!));
    expect(await text(router, "GET", "/hello/x")).toBe("x");
    expect((await call(router, "GET", "/hello/")).status).toBe(404);
  });

  test("the subtree root without its slash is a 301 before any middleware", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use(trace("global", log));
    router.get("/files/{path...}", (e) => e.string(200, e.params.path!));
    const res = await call(router, "GET", "/files?a=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/files/?a=1");
    expect(await res.text()).toBe(
      '<a href="/files/?a=1">Moved Permanently</a>.\n\n',
    );
    expect(log).toEqual([]);
    expect(await text(router, "GET", "/files/")).toBe("");
    expect((await call(router, "GET", "/filesx")).status).toBe(404);
  });

  test("a trailing wildcard counts as the trailing slash route", () => {
    const router = new Router();
    router.get("/x/", ok);
    expect(() => router.get("/x/{rest...}", ok)).toThrow(
      "is already registered",
    );
  });

  test("HEAD falls back to the GET route, an exact HEAD route wins", async () => {
    const router = new Router();
    router.get("/a", () => new Response("get"));
    router.get("/b", () => new Response("get"));
    router.head("/b", () => new Response("head"));
    expect(await text(router, "HEAD", "/a")).toBe("get");
    expect(await text(router, "HEAD", "/b")).toBe("head");
  });

  test("an action that writes nothing answers an empty 200", async () => {
    const router = new Router();
    router.get("/x", () => {});
    const res = await call(router, "GET", "/x");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("unbind in a middle group stops a grandparent middleware for its subtree only", async () => {
    const router = new Router();
    const log: string[] = [];
    router.use({ id: "a", fn: trace("a", log) });
    const g1 = router.group("/1");
    const g2 = g1.group("/2");
    const g3 = g2.group("/3");
    g1.get("/x", ok);
    g3.get("/x", ok);
    g2.unbind("a");
    await call(router, "GET", "/1/2/3/x");
    expect(log).toEqual([]);
    await call(router, "GET", "/1/x");
    expect(log).toEqual(["a"]);
  });
});

describe("RequestEvent", () => {
  test("json with ?fields= picks from the JSON form, only items for a list result", async () => {
    class Model {
      #data = { a: 1, b: 2 };
      toJSON() {
        return this.#data;
      }
    }
    const router = new Router();
    router.get("/model", (e) => e.json(200, new Model()));
    router.get("/list", (e) =>
      e.json(
        200,
        markListResult({ page: 1, items: [{ a: 1, b: 2 }, new Model()] }),
      ),
    );
    const res = await call(router, "GET", "/model?fields=a");
    expect(await res.json()).toEqual({ a: 1 });
    const list = await call(router, "GET", "/list?fields=b");
    expect(await list.json()).toEqual({ page: 1, items: [{ b: 2 }, { b: 2 }] });
  });

  test("error helpers: status text for error(), PB defaults for the named ones, safe data", () => {
    const e = createEvent(app, new Request("http://x/"), {});
    expect(e.error(400).message).toBe("Bad Request.");
    expect(e.error(418, "Teapot").message).toBe("Teapot.");
    expect(e.badRequestError().message).toBe(
      "Something went wrong while processing your request.",
    );
    expect(e.notFoundError().status).toBe(404);
    const invalid = {
      code: "validation_invalid_value",
      message: "Invalid value.",
    };
    expect(
      e.badRequestError("x", {
        a: "v",
        b: new Error("e"),
        c: { d: 1 },
        f: [1],
      }).data,
    ).toEqual({ a: invalid, b: invalid, c: { d: invalid }, f: invalid });
  });

  test("a plain thrown error is PB's 400, ENOENT a 404", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const plain = toApiError(new TypeError("boom"));
      expect([plain.status, plain.message]).toEqual([
        400,
        "Something went wrong while processing your request.",
      ]);
      expect(spy).toHaveBeenCalled();
      expect(
        toApiError(Object.assign(new Error("x"), { code: "ENOENT" })).status,
      ).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("app.register", () => {
  test("binds a Route class with its middlewares, rejects other classes", async () => {
    const reg = testApp();
    try {
      const log: string[] = [];
      class Hello extends Route {
        method = "get";
        path = "/hello/{name}";
        middlewares = [trace("mw", log)];
        handle(e: RequestEvent) {
          return e.string(200, e.params.name!);
        }
      }
      reg.register(Hello);
      expect(await text(reg.router, "GET", "/hello/x")).toBe("x");
      expect(log).toEqual(["mw"]);
      class Other {}
      expect(() => reg.register(Other)).toThrow(
        "Unsupported extension class Other",
      );
    } finally {
      reg.close();
    }
  });
});

describe("serve", () => {
  test("onServe can add routes, sees e.server after next(), and must call next()", async () => {
    const srv = testApp();
    try {
      let seen: unknown = "unset";
      srv.onServe(async (e) => {
        e.router.get("/added", (re) => re.string(200, "added"));
        await e.next();
        seen = e.server;
      });
      const server = await serve(srv, { host: "127.0.0.1", port: 0 });
      try {
        expect(seen).not.toBeNull();
        expect(await (await fetch(`${server.url}/added`)).text()).toBe("added");
      } finally {
        await server.stop();
      }
    } finally {
      srv.close();
    }

    const broken = testApp();
    try {
      broken.onServe(() => {});
      await expect(
        serve(broken, { host: "127.0.0.1", port: 0 }),
      ).rejects.toThrow("The OnServe listener was not initialized");
    } finally {
      broken.close();
    }
  });

  test("middleware headers reach error responses, keep their Content-Type and add up Vary", async () => {
    const router = new Router();
    router.use((e) => {
      e.responseHeaders.set("x-mw", "1");
      e.responseHeaders.set("content-type", "text/x-mw");
      e.responseHeaders.append("vary", "X-Mw");
      return e.next();
    });
    router.get("/ok", (e) => {
      const res = e.string(200, "ok");
      res.headers.set("vary", "Accept");
      return res;
    });
    router.get("/fail", (e) => {
      throw e.badRequestError("Nope.");
    });
    const server = await serve(app, { host: "127.0.0.1", port: 0, router });
    try {
      const ok = await fetch(`${server.url}/ok`);
      expect(ok.headers.get("content-type")).toBe("text/x-mw");
      expect(ok.headers.get("vary")).toBe("Origin, X-Mw, Accept");
      const fail = await fetch(`${server.url}/fail`);
      expect(fail.status).toBe(400);
      expect(fail.headers.get("x-mw")).toBe("1");
    } finally {
      await server.stop();
    }
  });
});

describe("RequestHookEvent.from", () => {
  test("shares the router event state, keeps its own next and extra", async () => {
    const re = createEvent(app, new Request("http://x/a"), {});
    re.extra.mw = true;
    const he = RecordRequestEvent.from(re, {
      collection: app.collections.find("users")!,
      record: undefined as never,
    });
    expect(he.extra).toEqual({});
    he.set("k", 1);
    expect(re.get("k")).toBe(1);
    he.auth = {
      record: { id: "u1" },
      collection: he.collection,
      isSuperuser: false,
    };
    expect(re.auth?.record.id).toBe("u1");
    expect(he.tags()).toEqual([he.collection.id, "users"]);

    const hook = new Hook<RecordRequestEvent>();
    hook.bind((e) => e.json(200, { hooked: true }));
    await hook.trigger(he, () => {
      throw new Error("next must not run");
    });
    expect(await re.response!.json()).toEqual({ hooked: true });
  });
});

describe("body limit", () => {
  const router = new Router();
  router.use(bodyLimit(DEFAULT_MAX_BODY_SIZE));
  router.post(
    "/echo",
    async (e) => e.json(200, await e.body()),
    bodyLimit(1024),
  );
  let server: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    server = await serve(app, { host: "127.0.0.1", port: 0, router });
  });
  afterAll(() => server.stop());
  const chunked = (size: number) =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"a":"${"x".repeat(size)}"}`));
        c.close();
      },
    });

  test("chunked body over the limit gets the same 413 as Content-Length", async () => {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    const sized = await fetch(`${server.url}/echo`, {
      ...init,
      body: `{"a":"${"x".repeat(2048)}"}`,
    });
    const streamed = await fetch(`${server.url}/echo`, {
      ...init,
      body: chunked(2048),
    });
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual(await sized.json());
  });

  test("chunked body under the limit is read", async () => {
    const res = await fetch(`${server.url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: chunked(10),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ a: "x".repeat(10) });
  });
});

describe("logUnexpected", () => {
  test("logs only errors that are not expected API failures", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const err of [
        new ApiError(400, ""),
        new ValidationError("x", {}),
        new FilterError("x"),
        new NotFoundError(),
      ])
        logUnexpected(err);
      expect(spy).not.toHaveBeenCalled();
      const bug = new TypeError("boom");
      logUnexpected(bug);
      expect(spy).toHaveBeenCalledWith(bug);
    } finally {
      spy.mockRestore();
    }
  });
});

test("serveOptions disables Bun's idle timeout like PB", () => {
  const opts = serveOptions({
    host: "127.0.0.1",
    port: 0,
    fetch: async () => new Response(),
  });
  expect(opts.idleTimeout).toBe(0);
});

describe("parseHttpAddr", () => {
  test("host:port, :port, [ipv6]:port and a bare port", () => {
    expect(parseHttpAddr("127.0.0.1:8090")).toEqual({
      host: "127.0.0.1",
      port: 8090,
    });
    expect(parseHttpAddr("example.com:80")).toEqual({
      host: "example.com",
      port: 80,
    });
    expect(parseHttpAddr(":8090")).toEqual({ host: "0.0.0.0", port: 8090 });
    expect(parseHttpAddr("[::1]:8090")).toEqual({ host: "::1", port: 8090 });
    expect(parseHttpAddr("8090")).toEqual({ host: "127.0.0.1", port: 8090 });
  });

  test("anything else is a clear error", () => {
    for (const addr of [
      "",
      "localhost",
      "a:b",
      "1.2.3.4:",
      "x:70000",
      "::1:80",
    ])
      expect(() => parseHttpAddr(addr)).toThrow(`Invalid --http address`);
  });
});
