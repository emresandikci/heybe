import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { fakeEnv } from "./test-env.js";

function setup(body: unknown = {}) {
  const env = fakeEnv();
  env.respond(() => Response.json(body));
  return { env, client: createClientWith("http://a", {}, env) };
}

const last = (env: ReturnType<typeof fakeEnv>) => {
  const req = env.requests.at(-1)!;
  const body = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
  return { method: req.method, url: req.url, body };
};

describe("collections", () => {
  test("findMany maps where, orderBy and paging to the query", async () => {
    const { env, client } = setup();
    await client.collections.findMany({
      where: { name: { like: "adm_" } },
      orderBy: { name: "desc" },
      page: 2,
      perPage: 5,
      count: false,
    });
    const { method, url } = last(env);
    expect(method).toBe("GET");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/collections");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      filter: 'name~"adm_"',
      sort: "-name",
      page: "2",
      perPage: "5",
      skipTotal: "1",
    });
  });

  test("findMany and crons.run pass request options through", async () => {
    const { env, client } = setup();
    await client.collections.findMany(undefined, { headers: { "X-A": "1" } });
    expect(env.requests.at(-1)!.headers.get("X-A")).toBe("1");
    await client.crons.run("a", { headers: { "X-A": "2" } });
    expect(env.requests.at(-1)!.headers.get("X-A")).toBe("2");
  });

  test("findMany without args sends no query", async () => {
    const { env, client } = setup();
    await client.collections.findMany();
    expect(last(env).url).toBe("http://a/api/collections");
  });

  test("findOne, update, delete, truncate encode the id or name", async () => {
    const { env, client } = setup();
    await client.collections.findOne("a/b");
    expect(last(env)).toMatchObject({
      method: "GET",
      url: "http://a/api/collections/a%2Fb",
    });
    await client.collections.update("a/b", { name: "c" });
    expect(last(env)).toMatchObject({
      method: "PATCH",
      url: "http://a/api/collections/a%2Fb",
      body: { name: "c" },
    });
    await client.collections.delete("a/b");
    expect(last(env)).toMatchObject({
      method: "DELETE",
      url: "http://a/api/collections/a%2Fb",
    });
    await client.collections.truncate("a/b");
    expect(last(env)).toMatchObject({
      method: "DELETE",
      url: "http://a/api/collections/a%2Fb/truncate",
    });
  });

  test("create posts the data", async () => {
    const { env, client } = setup();
    await client.collections.create({ name: "x", type: "base" });
    expect(last(env)).toEqual({
      method: "POST",
      url: "http://a/api/collections",
      body: { name: "x", type: "base" },
    });
  });

  test("import puts collections and deleteMissing, default false", async () => {
    const { env, client } = setup();
    await client.collections.import([{ name: "x" }]);
    expect(last(env)).toEqual({
      method: "PUT",
      url: "http://a/api/collections/import",
      body: { collections: [{ name: "x" }], deleteMissing: false },
    });
    await client.collections.import([], true);
    expect(last(env).body).toEqual({ collections: [], deleteMissing: true });
  });

  test("scaffolds", async () => {
    const { env, client } = setup();
    await client.collections.scaffolds();
    expect(last(env)).toMatchObject({
      method: "GET",
      url: "http://a/api/collections/meta/scaffolds",
    });
  });
});

describe("settings", () => {
  test("get and update", async () => {
    const { env, client } = setup();
    await client.settings.get();
    expect(last(env)).toMatchObject({
      method: "GET",
      url: "http://a/api/settings",
    });
    await client.settings.update({ meta: { appName: "x" } });
    expect(last(env)).toEqual({
      method: "PATCH",
      url: "http://a/api/settings",
      body: { meta: { appName: "x" } },
    });
  });

  test("testEmail", async () => {
    const { env, client } = setup();
    await client.settings.testEmail("users", "a@b.c", "verification");
    expect(last(env)).toEqual({
      method: "POST",
      url: "http://a/api/settings/test/email",
      body: { email: "a@b.c", template: "verification", collection: "users" },
    });
  });

  test("generateAppleClientSecret", async () => {
    const { env, client } = setup({ secret: "s" });
    const result = await client.settings.generateAppleClientSecret(
      "cid",
      "tid",
      "kid",
      "pem",
      3600,
    );
    expect(result).toEqual({ secret: "s" });
    expect(last(env)).toEqual({
      method: "POST",
      url: "http://a/api/settings/apple/generate-client-secret",
      body: {
        clientId: "cid",
        teamId: "tid",
        keyId: "kid",
        privateKey: "pem",
        duration: 3600,
      },
    });
  });
});

describe("crons and health", () => {
  test("list and run", async () => {
    const { env, client } = setup();
    await client.crons.list();
    expect(last(env)).toMatchObject({
      method: "GET",
      url: "http://a/api/crons",
    });
    await client.crons.run("a/b");
    expect(last(env)).toMatchObject({
      method: "POST",
      url: "http://a/api/crons/a%2Fb",
    });
  });

  test("health check", async () => {
    const { env, client } = setup();
    await client.health.check();
    expect(last(env)).toMatchObject({
      method: "GET",
      url: "http://a/api/health",
    });
  });
});

describe("settings.testS3", () => {
  test("posts the filesystem", async () => {
    const { env, client } = setup();
    await client.settings.testS3("backups");
    expect(last(env)).toMatchObject({
      method: "POST",
      url: "http://a/api/settings/test/s3",
      body: { filesystem: "backups" },
    });
  });
});
