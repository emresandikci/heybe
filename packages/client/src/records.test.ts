import { describe, expect, test } from "bun:test";
import { memoryStore } from "./auth-store.js";
import { createClientWith } from "./client.js";
import { HeybeError } from "./error.js";
import { fakeEnv } from "./test-env.js";

function setup() {
  const env = fakeEnv();
  const authStore = memoryStore();
  const client = createClientWith("http://a", { authStore }, env);
  return { env, authStore, client };
}

const list = { page: 1, perPage: 30, totalItems: 0, totalPages: 0, items: [] };

describe("records", () => {
  test("findMany maps args to the PB query", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    await client.records("posts").findMany({
      where: { status: "a", views: { gt: 5 } },
      orderBy: { created: "desc" },
      expand: { author: true },
      page: 2,
      perPage: 10,
      count: false,
    });
    expect(env.requests[0]!.method).toBe("GET");
    expect(env.requests[0]!.url).toBe(
      "http://a/api/collections/posts/records?page=2&perPage=10&skipTotal=1&filter=status%3D%22a%22%20%26%26%20views%3E5&sort=-created&expand=author",
    );
  });

  test("findMany sends filter and sort raw strings", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    await client
      .records("posts")
      .findMany({ filter: 'title ~ "a b"', sort: "-@rowid" });
    const url = new URL(env.requests[0]!.url);
    expect(url.searchParams.get("filter")).toBe('title ~ "a b"');
    expect(url.searchParams.get("sort")).toBe("-@rowid");
  });

  test("where and filter are joined with &&", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    await client
      .records("posts")
      .findMany({ where: { title: "a" }, filter: "views > 1" });
    const url = new URL(env.requests[0]!.url);
    expect(url.searchParams.get("filter")).toBe('(title="a") && (views > 1)');
  });

  test("orderBy and sort are joined with a comma", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json({ ...list, items: [{ id: "a" }] }));
    await client
      .records("posts")
      .findFirst({ orderBy: { created: "desc" }, sort: "@rowid" });
    const url = new URL(env.requests[0]!.url);
    expect(url.searchParams.get("sort")).toBe("-created,@rowid");
  });

  test("findMany() sends no query", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    await client.records("posts").findMany();
    expect(env.requests[0]!.url).toBe("http://a/api/collections/posts/records");
  });

  test("undefined where values are skipped", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    await client.records("posts").findMany({ where: { status: undefined } });
    expect(env.requests[0]!.url).toBe("http://a/api/collections/posts/records");
  });

  test("findOne encodes the id and expand", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json({ id: "a/b" }));
    await client.records("po sts").findOne("a/b", { expand: { author: true } });
    expect(env.requests[0]!.url).toBe(
      "http://a/api/collections/po%20sts/records/a%2Fb?expand=author",
    );
  });

  test("findOne empty id rejects 404 without a request", async () => {
    const { env, client } = setup();
    const err = await client
      .records("posts")
      .findOne("")
      .catch((e) => e);
    expect(err).toBeInstanceOf(HeybeError);
    expect(err.status).toBe(404);
    expect(err.response).toEqual({
      code: 404,
      message: "Missing required record id.",
      data: {},
    });
    expect(env.requests).toHaveLength(0);
  });

  test("findFirst uses its own request key and 404s on empty", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    const err = await client
      .records("posts")
      .findFirst({ where: { status: "a" }, orderBy: { id: "asc" } })
      .catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.response).toEqual({
      code: 404,
      message: "The requested resource wasn't found.",
      data: {},
    });
    expect(env.requests[0]!.url).toBe(
      "http://a/api/collections/posts/records?page=1&perPage=1&skipTotal=1&filter=status%3D%22a%22&sort=id",
    );
  });

  test("findFirst does not cancel a pending findMany", async () => {
    const { env, client } = setup();
    env.respond((req) =>
      req.url.includes("perPage=1")
        ? Response.json(list)
        : new Promise(() => {}),
    );
    const many = client
      .records("posts")
      .findMany()
      .catch((e) => e);
    await client
      .records("posts")
      .findFirst()
      .catch((e) => e);
    client.cancelAllRequests();
    expect(await many).toMatchObject({ isAbort: true });
    expect(env.requests).toHaveLength(2);
  });

  test("two parallel findMany on one collection: first is auto-cancelled", async () => {
    const { env, client } = setup();
    let calls = 0;
    env.respond(() =>
      ++calls === 1 ? new Promise(() => {}) : Response.json(list),
    );
    const first = client
      .records("posts")
      .findMany()
      .catch((e) => e);
    const second = client.records("posts").findMany();
    expect(await first).toMatchObject({ isAbort: true });
    expect((await second).items).toEqual([]);
  });

  test("requestKey null keeps both", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json(list));
    const results = await Promise.all([
      client.records("posts").findMany(undefined, { requestKey: null }),
      client.records("posts").findMany(undefined, { requestKey: null }),
    ]);
    expect(results.map((r) => r.items)).toEqual([[], []]);
  });

  test("create with a File sends FormData", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json({ id: "x" }));
    await client
      .records("posts")
      .create({ title: "a", cover: new File(["x"], "c.png") });
    const req = env.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.body).toBeInstanceOf(FormData);
    expect((req.body as FormData).get("title")).toBe("a");
    expect((req.body as FormData).get("cover")).toBeInstanceOf(File);
  });

  test("create sends expand in the query", async () => {
    const { env, client } = setup();
    env.respond(() => Response.json({ id: "x" }));
    await client
      .records("posts")
      .create({ title: "a" }, { expand: { author: true } });
    expect(env.requests[0]!.url).toBe(
      "http://a/api/collections/posts/records?expand=author",
    );
  });

  test("update of the auth record updates the store keeping expand", async () => {
    const { env, authStore, client } = setup();
    authStore.save("tok", {
      id: "u1",
      collectionId: "c1",
      collectionName: "users",
      name: "old",
      expand: { org: { id: "o1" } },
    });
    env.respond(() =>
      Response.json({
        id: "u1",
        collectionId: "c1",
        collectionName: "users",
        name: "new",
      }),
    );
    await client.records("users").update("u1", { name: "new" });
    expect(env.requests[0]!.method).toBe("PATCH");
    expect(authStore.token).toBe("tok");
    expect(authStore.record).toMatchObject({
      name: "new",
      expand: { org: { id: "o1" } },
    });
  });

  test("update of another record leaves the store alone", async () => {
    const { env, authStore, client } = setup();
    authStore.save("tok", {
      id: "u1",
      collectionId: "c1",
      collectionName: "users",
      name: "old",
    });
    env.respond(() =>
      Response.json({ id: "u2", collectionName: "users", name: "x" }),
    );
    await client.records("users").update("u2", { name: "x" });
    expect(authStore.record!.name).toBe("old");
  });

  test("delete of the auth record clears the store", async () => {
    const { env, authStore, client } = setup();
    authStore.save("tok", {
      id: "u1",
      collectionId: "c1",
      collectionName: "users",
    });
    env.respond(() => new Response(null, { status: 204 }));
    await client.records("users").delete("u1");
    expect(env.requests[0]!.method).toBe("DELETE");
    expect(authStore.token).toBe("");
    expect(authStore.record).toBeNull();
  });
});
