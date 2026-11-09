import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

function setup(body: unknown = {}) {
  const env = fakeEnv();
  env.respond(() => Response.json(body));
  return { env, client: createClientWith("http://a", {}, env) };
}

describe("logs", () => {
  test("findMany maps where, orderBy and paging to the query", async () => {
    const { env, client } = setup();
    await client.logs.findMany({
      where: { "data.status": { gte: 400 }, level: 8 },
      orderBy: { created: "desc" },
      page: 2,
      perPage: 5,
      count: false,
    });
    const req = env.requests.at(-1)!;
    const url = new URL(req.url);
    expect(req.method).toBe("GET");
    expect(url.pathname).toBe("/api/logs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: "data.status>=400 && level=8",
      sort: "-created",
      page: "2",
      perPage: "5",
      skipTotal: "1",
    });
  });

  test("findOne encodes the id", async () => {
    const { env, client } = setup();
    await client.logs.findOne("a/b");
    expect(env.requests.at(-1)).toMatchObject({
      method: "GET",
      url: "http://a/api/logs/a%2Fb",
    });
  });

  test("stats maps where to the filter", async () => {
    const { env, client } = setup([]);
    await client.logs.stats({ where: { level: 4 } });
    const req = env.requests.at(-1)!;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/api/logs/stats");
    expect(url.searchParams.get("filter")).toBe("level=4");
    await client.logs.stats();
    expect(env.requests.at(-1)!.url).toBe("http://a/api/logs/stats");
  });

  test("truncate deletes all logs", async () => {
    const { env, client } = setup();
    await client.logs.truncate({ headers: { "X-A": "1" } });
    const req = env.requests.at(-1)!;
    expect(req).toMatchObject({ method: "DELETE", url: "http://a/api/logs" });
    expect(req.headers.get("X-A")).toBe("1");
  });
});
