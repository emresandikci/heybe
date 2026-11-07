import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { createEvent } from "../http/router";
import { buildRequestInfo } from "./rules";

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
