import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { statementCacheSize } from "../db";
import { createEvent } from "../http/router";
import { buildRequestInfo, matchesDraft } from "./rules";
import { internalRecords } from "./internal";

describe("buildRequestInfo", () => {
  test("snake_case header keys, first query value, auth and context", () => {
    const app = createApp({ dir: ":memory:" });
    const req = new Request("http://x/api?a=1&a=2&__proto__=p", {
      method: "PATCH",
      headers: { "X-Api-Key": "k", "content-type": "application/json" },
    });
    const e = createEvent(app, req, {});
    const info = buildRequestInfo(e, { title: "t" }, "password");
    expect(info).toEqual({
      auth: null,
      authCollection: null,
      body: { title: "t" },
      query: { a: "1", ["__proto__"]: "p" },
      headers: { x_api_key: "k", content_type: "application/json" },
      method: "PATCH",
      context: "password",
    });
    expect(Object.hasOwn(info.query, "__proto__")).toBe(true);
    app.close();
  });
});

describe("statement cache", () => {
  test("paging and create-rule draft checks reuse the same statements", async () => {
    const app = createApp({
      dir: ":memory:",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const c = await app.collections.save({
      name: "posts",
      fields: [{ name: "title", type: "text" }] as any,
      createRule: "title != ''",
    });
    const info = buildRequestInfo(
      createEvent(app, new Request("http://x/api"), {}),
      {},
    );
    const run = (i: number) => {
      internalRecords(app, "posts").query({
        page: i + 1,
        perPage: (i % 50) + 1,
      });
      matchesDraft(app, c, { id: "", title: "t" }, c.createRule!, info);
    };
    run(0);
    const size = statementCacheSize(app.db);
    for (let i = 1; i < 300; i++) run(i);
    expect(statementCacheSize(app.db)).toBe(size);
    app.close();
  });
});
