import { expect, test } from "bun:test";
import { withHeaders } from "./server";

const middleware = () =>
  new Headers({ "x-a": "1", "content-type": "text/plain", vary: "Origin" });

test("middleware headers merge into the response in place", async () => {
  const res = new Response("body", {
    headers: { "x-a": "own", "content-type": "text/html", vary: "Accept" },
  });
  const out = withHeaders(res, middleware());
  expect(out).toBe(res);
  expect(out.headers.get("x-a")).toBe("own");
  expect(out.headers.get("content-type")).toBe("text/plain");
  expect(out.headers.get("vary")).toBe("Origin, Accept");
  expect(await out.text()).toBe("body");
});

test("a response with immutable headers is copied", async () => {
  const res = new Response("body", { status: 201 });
  const frozen = new Headers(res.headers);
  frozen.set = () => {
    throw new TypeError("immutable");
  };
  Object.defineProperty(res, "headers", { value: frozen });
  const out = withHeaders(res, middleware());
  expect(out).not.toBe(res);
  expect(out.status).toBe(201);
  expect(out.headers.get("x-a")).toBe("1");
  expect(await out.text()).toBe("body");
});
