import { expect, test } from "bun:test";
import { fakeServer } from "./fake-server";

test("fake server matches method and path, parses JSON and FormData bodies, records unmatched", async () => {
  const server = fakeServer();
  server.on("POST", "/api/things", (req) => ({ got: req.body }), 201);
  server.on("GET", "/api/things", { items: [] });

  const created = await server.fetch("http://x/api/things?a=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: 1 }),
  });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ got: { n: 1 } });
  expect(server.find("POST", "/api/things")[0]!.query.get("a")).toBe("1");

  const form = new FormData();
  form.set("title", "hi");
  await server.fetch("http://x/api/things", { method: "POST", body: form });
  expect(server.find("POST", "/api/things")[1]!.form!.get("title")).toBe("hi");

  const missing = await server.fetch("http://x/api/nope");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    code: 404,
    message: "No fake route.",
    data: {},
  });
  expect(server.unmatched.map((r) => r.path)).toEqual(["/api/nope"]);
  server.unmatched.length = 0;
});

test("last registered route wins", async () => {
  const server = fakeServer();
  server.on("GET", "/a", { v: 1 }).on("GET", "/a", { v: 2 });
  const res = await server.fetch("http://x/a");
  expect(await res.json()).toEqual({ v: 2 });
});

test("async reply functions are awaited", async () => {
  const server = fakeServer();
  server.on("GET", "/slow", async () => ({ ok: true }));
  expect(await (await server.fetch("http://x/slow")).json()).toEqual({
    ok: true,
  });
});
