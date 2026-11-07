import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { Router } from "./router";
import { serve } from "./server";

const ok = () => new Response("ok");

describe("Router", () => {
  test("literal segments win over params regardless of registration order", () => {
    const router = new Router();
    const param = () => new Response("param");
    const literal = () => new Response("literal");
    router.add("GET", "/api/collections/{collection}", param);
    router.add("GET", "/api/collections/meta/scaffolds", literal);
    router.add("GET", "/api/collections/{collection}/records", ok);
    expect(router.match("GET", "/api/collections/meta/scaffolds")?.h).toBe(
      literal,
    );
    expect(router.match("GET", "/api/collections/users")?.h).toBe(param);
  });

  test("wildcard catch-all never shadows specific routes", () => {
    const router = new Router();
    const catchAll = () => new Response("all");
    router.add("GET", "/{path...}", catchAll);
    router.add("GET", "/api/health", ok);
    expect(router.match("GET", "/api/health")?.h).toBe(ok);
    expect(router.match("GET", "/api/nope")?.h).toBe(catchAll);
  });
});

describe("body limit", () => {
  const router = new Router();
  router.add("POST", "/echo", async (e) => e.json(200, await e.body()), {
    bodyLimit: 1024,
  });
  const app = createApp({ dir: ":memory:" });
  const server = serve(app, { host: "127.0.0.1", port: 0, router });

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
