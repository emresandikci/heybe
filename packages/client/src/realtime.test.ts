import { describe, expect, test } from "bun:test";
import { memoryStore } from "./auth-store.js";
import { createClientWith, type ClientOptions } from "./client.js";
import { HeybeError } from "./error.js";
import { fakeEnv, jwt, sseStream } from "./test-env.js";

const USER = { id: "u1", collectionId: "c", collectionName: "users" };

function setup(opts: ClientOptions = {}) {
  const env = fakeEnv();
  const authStore = memoryStore(env.now);
  const client = createClientWith("http://a", { ...opts, authStore }, env);
  const streams: ReturnType<typeof sseStream>[] = [];
  let refreshes = 0;
  env.respond((req) => {
    if (req.method === "GET" && req.url === "http://a/api/realtime") {
      const stream = sseStream();
      streams.push(stream);
      return stream.response;
    }
    if (req.url.endsWith("/auth-refresh"))
      return Response.json({
        token: jwt({ ...USER, type: "auth", exp: 60, n: ++refreshes }),
        record: USER,
      });
    return new Response(null, { status: 204 });
  });
  const gets = () => env.requests.filter((r) => r.method === "GET");
  const posts = () =>
    env.requests.filter(
      (r) => r.method === "POST" && r.url === "http://a/api/realtime",
    );
  const lastPost = () => JSON.parse(posts().at(-1)!.body as string);
  const stream = () => streams.at(-1)!;
  const connect = async (id: string) => {
    stream().push(`id:${id}\nevent:HB_CONNECT\ndata:{"clientId":"${id}"}\n\n`);
    await env.advance(0);
  };
  const emit = async (event: string, data: string) => {
    stream().push(`event:${event}\ndata:${data}\n\n`);
    await env.advance(0);
  };
  async function subscribed(
    topics: string[],
    fn: (data: any) => void = () => {},
  ) {
    const unsubs = topics.map((t) => client.realtime.subscribe(t, fn));
    await env.advance(0);
    await connect("c1");
    return Promise.all(unsubs);
  }
  return {
    env,
    authStore,
    client,
    streams,
    gets,
    posts,
    lastPost,
    stream,
    connect,
    emit,
    subscribed,
  };
}

describe("realtime", () => {
  test("subscribe connects, reads HB_CONNECT and posts the subscriptions", async () => {
    const t = setup();
    const connected: unknown[] = [];
    let resolved = false;
    const pending = t.client.realtime
      .subscribe("posts/*", () => {})
      .then(() => (resolved = true));
    void t.client.realtime.subscribe("HB_CONNECT", (e) => connected.push(e));
    await t.env.advance(0);
    expect(t.gets()).toHaveLength(1);
    expect(t.gets()[0]!.headers.get("Accept")).toBe("text/event-stream");
    expect(resolved).toBe(false);
    expect(t.client.realtime.isConnected).toBe(false);

    await t.connect("c1");
    await pending;
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0]!.url).toBe("http://a/api/realtime");
    expect(t.lastPost()).toEqual({
      clientId: "c1",
      subscriptions: ["posts/*", "HB_CONNECT"],
    });
    expect(t.client.realtime.clientId).toBe("c1");
    expect(t.client.realtime.isConnected).toBe(true);
    expect(connected).toEqual([{ clientId: "c1" }]);
  });

  test("topic options are serialized into the key", async () => {
    const t = setup();
    void t.client.realtime.subscribe("posts/*", () => {}, {
      query: { filter: "a=1" },
      headers: { x: "y" },
    });
    void t.client.realtime.subscribe("posts/r1?a=1", () => {}, {});
    await t.env.advance(0);
    await t.connect("c1");
    expect(t.lastPost().subscriptions).toEqual([
      "posts/*?options=" +
        encodeURIComponent('{"query":{"filter":"a=1"},"headers":{"x":"y"}}'),
      "posts/r1?a=1&options=" + encodeURIComponent("{}"),
    ]);
  });

  test("second listener on a sent key posts nothing", async () => {
    const t = setup();
    const got: string[] = [];
    await t.subscribed(["posts/*"], () => got.push("a"));
    await t.client.realtime.subscribe("posts/*", () => got.push("b"));
    await t.env.advance(0);
    expect(t.posts()).toHaveLength(1);
    await t.emit("posts/*", "{}");
    expect(got).toEqual(["a", "b"]);
  });

  test("last unsubscribe disconnects", async () => {
    const t = setup();
    const [unsubA, unsubB] = await t.subscribed(["a", "b"]);
    await unsubA!();
    expect(t.lastPost().subscriptions).toEqual(["b"]);
    await unsubB!();
    expect(t.posts()).toHaveLength(2);
    expect(t.stream().cancelled).toBe(true);
    expect(t.client.realtime.isConnected).toBe(false);
    expect(t.client.realtime.clientId).toBe("");
  });

  test("events reach the matching listeners only", async () => {
    const t = setup();
    const got: unknown[] = [];
    void t.client.realtime.subscribe("posts/*", (d) => got.push(["all", d]));
    void t.client.realtime.subscribe("posts/r1", (d) => got.push(["one", d]));
    await t.env.advance(0);
    await t.connect("c1");
    await t.emit("posts/*", '{"action":"create"}');
    await t.emit("posts/r1", "not json");
    await t.emit("other", "{}");
    expect(got).toEqual([
      ["all", { action: "create" }],
      ["one", {}],
    ]);
  });

  test("stream end reconnects after 200, then 300 ms ... capped at 2000", async () => {
    const t = setup();
    await t.subscribed(["posts/*"]);
    for (const delay of [200, 300, 500, 1000, 1200, 1500, 2000, 2000]) {
      const count = t.gets().length;
      t.stream().end();
      await t.env.advance(delay - 1);
      expect(t.gets()).toHaveLength(count);
      await t.env.advance(1);
      expect(t.gets()).toHaveLength(count + 1);
    }
    await t.connect("c2");
    t.stream().fail();
    await t.env.advance(199);
    expect(t.gets()).toHaveLength(9);
    await t.env.advance(1);
    expect(t.gets()).toHaveLength(10);
  });

  test("reconnect re-submits every key under the new client id", async () => {
    const t = setup();
    const got: unknown[] = [];
    void t.client.realtime.subscribe("a", (d) => got.push(d));
    void t.client.realtime.subscribe("b", () => {}, { query: { x: 1 } });
    await t.env.advance(0);
    await t.connect("c1");
    t.stream().end();
    await t.env.advance(200);
    await t.connect("c2");
    expect(t.posts()).toHaveLength(2);
    expect(t.lastPost()).toEqual({
      clientId: "c2",
      subscriptions: [
        "a",
        "b?options=" + encodeURIComponent('{"query":{"x":1}}'),
      ],
    });
    await t.emit("a", '{"n":1}');
    expect(got).toEqual([{ n: 1 }]);
  });

  test("connect timeout after 15000 ms schedules a reconnect", async () => {
    const t = setup();
    await t.subscribed(["a"]);
    t.stream().end();
    await t.env.advance(200);
    expect(t.gets()).toHaveLength(2);
    await t.env.advance(14999);
    expect(t.stream().cancelled).toBe(false);
    await t.env.advance(1);
    expect(t.stream().cancelled).toBe(true);
    await t.env.advance(300);
    expect(t.gets()).toHaveLength(3);
  });

  test("first connect timeout rejects the subscribe", async () => {
    const t = setup();
    const pending = t.client.realtime.subscribe("a", () => {});
    const result = pending.catch((err) => err);
    await t.env.advance(15000);
    expect(await result).toBeInstanceOf(HeybeError);
    expect(t.stream().cancelled).toBe(true);
    await t.env.advance(60000);
    expect(t.gets()).toHaveLength(1);
  });

  test("unsubscribe during a pending reconnect leaves no timer and no open stream", async () => {
    const t = setup();
    await t.subscribed(["a"]);
    t.stream().end();
    await t.env.advance(100);
    await t.client.realtime.unsubscribe();
    await t.env.advance(60000);
    expect(t.gets()).toHaveLength(1);

    void t.client.realtime.subscribe("a", () => {});
    await t.env.advance(0);
    await t.connect("c2");
    t.stream().end();
    await t.env.advance(200);
    expect(t.gets()).toHaveLength(3);
    await t.client.realtime.unsubscribe("a");
    expect(t.stream().cancelled).toBe(true);
    await t.env.advance(60000);
    expect(t.gets()).toHaveLength(3);
    expect(t.client.realtime.isConnected).toBe(false);
  });

  test("onDisconnect gets the active topics", async () => {
    const t = setup();
    const calls: string[][] = [];
    t.client.realtime.onDisconnect = (topics) => calls.push(topics);
    await t.subscribed(["a", "b"]);
    t.stream().end();
    await t.env.advance(0);
    expect(calls).toEqual([["a", "b"]]);
  });

  test("auth store change reconnects with the new token", async () => {
    const t = setup();
    const first = jwt({ exp: 9e9, type: "auth" });
    const second = jwt({ exp: 9e9, type: "auth", id: "u2" });
    t.authStore.save(first, USER);
    await t.subscribed(["a"]);
    expect(t.posts()[0]!.headers.get("Authorization")).toBe(first);

    t.authStore.save(first, { ...USER, name: "x" });
    await t.env.advance(0);
    expect(t.gets()).toHaveLength(1);

    t.authStore.save(second, { ...USER, id: "u2" });
    await t.env.advance(0);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.gets()).toHaveLength(2);
    await t.connect("c2");
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a"] });
    expect(t.posts().at(-1)!.headers.get("Authorization")).toBe(second);
  });

  test("same-record token change keeps the stream and resubmits once", async () => {
    const t = setup();
    const second = jwt({ exp: 9e9, type: "auth", n: 2 });
    t.authStore.save(jwt({ exp: 9e9, type: "auth" }), USER);
    await t.subscribed(["a"]);

    t.authStore.save(second, USER);
    await t.env.advance(0);
    expect(t.gets()).toHaveLength(1);
    expect(t.streams[0]!.cancelled).toBe(false);
    expect(t.posts()).toHaveLength(2);
    expect(t.lastPost()).toEqual({ clientId: "c1", subscriptions: ["a"] });
    expect(t.posts().at(-1)!.headers.get("Authorization")).toBe(second);
    expect(t.client.realtime.isConnected).toBe(true);
  });

  test("tokens of different records saved without a record reconnect", async () => {
    const t = setup();
    t.authStore.save(
      jwt({ exp: 9e9, type: "auth", collectionId: "c", id: "u1" }),
      null,
    );
    await t.subscribed(["a"]);
    t.authStore.save(
      jwt({ exp: 9e9, type: "auth", collectionId: "c", id: "u2" }),
      null,
    );
    await t.env.advance(0);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.gets()).toHaveLength(2);
  });

  test("record collectionId change reconnects", async () => {
    const t = setup();
    const token = jwt({ exp: 9e9, type: "auth" });
    t.authStore.save(token, USER);
    await t.subscribed(["a"]);
    t.authStore.save(token + "x", { ...USER, collectionId: "other" });
    await t.env.advance(0);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.gets()).toHaveLength(2);
  });

  test("auto refresh on every submit (token lifetime below the threshold) stays connected", async () => {
    const t = setup({ autoRefreshThreshold: 300 });
    t.authStore.save(jwt({ ...USER, type: "auth", exp: 60 }), USER);
    const refreshes = () =>
      t.env.requests.filter((r) => r.url.endsWith("/auth-refresh"));
    await t.subscribed(["a"]);
    expect(refreshes()).toHaveLength(1);
    expect(t.posts()).toHaveLength(1);

    await t.client.realtime.subscribe("b", () => {});
    await t.env.advance(0);
    expect(refreshes()).toHaveLength(2);
    expect(t.posts()).toHaveLength(2);
    expect(t.lastPost()).toEqual({ clientId: "c1", subscriptions: ["a", "b"] });
    expect(t.posts().at(-1)!.headers.get("Authorization")).toBe(
      t.authStore.token,
    );
    expect(t.gets()).toHaveLength(1);
    expect(t.client.realtime.isConnected).toBe(true);
  });

  test("clear() reconnects without Authorization", async () => {
    const t = setup();
    t.authStore.save(jwt({ exp: 9e9, type: "auth" }), USER);
    await t.subscribed(["a"]);
    t.authStore.clear();
    await t.env.advance(0);
    expect(t.streams[0]!.cancelled).toBe(true);
    await t.connect("c2");
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a"] });
    expect(t.posts().at(-1)!.headers.has("Authorization")).toBe(false);
  });

  test("auth change restart retries after 200 ms when its connect fails", async () => {
    const t = setup();
    t.authStore.save(jwt({ exp: 9e9, type: "auth" }), USER);
    await t.subscribed(["a"]);
    t.env.respond((req) =>
      req.method === "GET"
        ? new Response("down", { status: 500 })
        : new Response(null, { status: 204 }),
    );
    t.authStore.clear();
    await t.env.advance(199);
    expect(t.gets()).toHaveLength(2);
    t.env.respond((req) => {
      if (req.method !== "GET") return new Response(null, { status: 204 });
      t.streams.push(sseStream());
      return t.stream().response;
    });
    await t.env.advance(1);
    expect(t.gets()).toHaveLength(3);
    await t.connect("c2");
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a"] });
    expect(t.client.realtime.isConnected).toBe(true);
  });

  test("subscribe during an auth change restart joins it", async () => {
    const t = setup();
    t.authStore.save(jwt({ exp: 9e9, type: "auth" }), USER);
    await t.subscribed(["a"]);
    t.authStore.clear();
    let resolved = false;
    const pending = t.client.realtime
      .subscribe("b", () => {})
      .then(() => (resolved = true));
    await t.env.advance(0);
    expect(t.gets()).toHaveLength(2);
    expect(t.streams[1]!.cancelled).toBe(false);
    expect(resolved).toBe(false);
    await t.connect("c2");
    await pending;
    expect(t.gets()).toHaveLength(2);
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a", "b"] });
  });

  test("auth change while a subscription POST is in flight", async () => {
    const t = setup();
    const first = jwt({ exp: 9e9, type: "auth" });
    const second = jwt({ exp: 9e9, type: "auth", id: "u2" });
    t.authStore.save(first, USER);
    const aborted: boolean[] = [];
    t.env.respond((req) => {
      if (req.method === "GET") {
        t.streams.push(sseStream());
        return t.stream().response;
      }
      if (t.posts().length > 1) return new Response(null, { status: 204 });
      return new Promise<Response>((_, reject) =>
        req.signal.addEventListener("abort", () => {
          aborted.push(true);
          reject(new DOMException("Aborted", "AbortError"));
        }),
      );
    });
    let error: unknown;
    const pending = t.client.realtime
      .subscribe("a", () => {})
      .catch((err) => {
        error = err;
      });
    await t.env.advance(0);
    await t.connect("c1");
    expect(t.posts()).toHaveLength(1);
    t.authStore.save(second, { ...USER, id: "u2" });
    await t.env.advance(0);
    expect(aborted).toEqual([true]);
    expect(t.gets()).toHaveLength(2);
    await t.connect("c2");
    await pending;
    expect(error).toBeUndefined();
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a"] });
    expect(t.posts().at(-1)!.headers.get("Authorization")).toBe(second);
    expect(t.client.realtime.isConnected).toBe(true);
  });

  test("auth change during a pending reconnect uses the new token", async () => {
    const t = setup();
    const second = jwt({ exp: 9e9, type: "auth", id: "u2" });
    t.authStore.save(jwt({ exp: 9e9, type: "auth" }), USER);
    await t.subscribed(["a"]);
    t.stream().end();
    await t.env.advance(100);
    t.authStore.save(second, { ...USER, id: "u2" });
    await t.env.advance(99);
    expect(t.gets()).toHaveLength(1);
    await t.env.advance(1);
    expect(t.gets()).toHaveLength(2);
    await t.connect("c2");
    expect(t.lastPost()).toEqual({ clientId: "c2", subscriptions: ["a"] });
    expect(t.posts().at(-1)!.headers.get("Authorization")).toBe(second);
  });

  test("unsubscribe(topic) removes option-suffixed keys", async () => {
    const t = setup();
    void t.client.realtime.subscribe("a", () => {});
    void t.client.realtime.subscribe("a", () => {}, { query: { x: 1 } });
    void t.client.realtime.subscribe("ab", () => {});
    await t.env.advance(0);
    await t.connect("c1");
    expect(t.lastPost().subscriptions).toHaveLength(3);
    await t.client.realtime.unsubscribe("a");
    expect(t.lastPost().subscriptions).toEqual(["ab"]);
  });

  test("unsubscribeByPrefix", async () => {
    const t = setup();
    void t.client.realtime.subscribe("posts/1", () => {});
    void t.client.realtime.subscribe("posts/2", () => {}, { query: { x: 1 } });
    void t.client.realtime.subscribe("users/1", () => {});
    await t.env.advance(0);
    await t.connect("c1");
    await t.client.realtime.unsubscribeByPrefix("none");
    expect(t.posts()).toHaveLength(1);
    await t.client.realtime.unsubscribeByPrefix("posts/");
    expect(t.posts()).toHaveLength(2);
    expect(t.lastPost().subscriptions).toEqual(["users/1"]);
  });

  test("several subscribes in one tick on a connected client give one POST", async () => {
    const t = setup();
    await t.subscribed(["a"]);
    await Promise.all(
      ["b", "c", "d"].map((topic) =>
        t.client.realtime.subscribe(topic, () => {}),
      ),
    );
    expect(t.posts()).toHaveLength(2);
    expect(t.lastPost().subscriptions).toEqual(["a", "b", "c", "d"]);
  });

  test("records subscribe builds collection/topic with filter and expand", async () => {
    const t = setup();
    const posts = t.client.records("posts");
    const got: unknown[] = [];
    void posts.subscribe("*", (e) => got.push(e), {
      where: { status: "a" },
      expand: { author: true },
    });
    void posts.subscribe("r1", () => {});
    await t.env.advance(0);
    await t.connect("c1");
    const all =
      "posts/*?options=" +
      encodeURIComponent(
        '{"query":{"filter":"status=\\"a\\"","expand":"author"}}',
      );
    expect(t.lastPost().subscriptions).toEqual([all, "posts/r1"]);
    await t.emit(all, '{"action":"create","record":{"id":"r2"}}');
    expect(got).toEqual([{ action: "create", record: { id: "r2" } }]);
    await posts.unsubscribe();
    expect(t.client.realtime.isConnected).toBe(false);
  });
});
