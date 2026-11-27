import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../app";
import { testApp } from "../test-app";
import { takeAppleName } from "../auth/oauth2/flow";
import { errorResponse } from "../http/errors";
import type { AuthState } from "../http/router";
import { createEvent } from "../http/router";
import { createRouter } from "../http/server";
import { internalRecords } from "../records/internal";
import { fakeClock } from "../test-clock";
import { AUTH_KEY, IP_KEY } from "./broadcast";
import { Client } from "./broker";

let app: App;
let clock: ReturnType<typeof fakeClock>;

beforeEach(() => {
  clock = fakeClock();
  app = testApp({ timers: clock.timers });
});

afterEach(() => app.close());

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function call(req: Request, ip = "9.9.9.9"): Promise<Response> {
  const found = createRouter()
    .build()
    .match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params, ip);
  try {
    return await found.run(e);
  } catch (err) {
    return e.response ?? errorResponse(err);
  }
}

async function connect() {
  const res = await call(new Request("http://x/api/realtime"));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const frame = async (): Promise<string | null> => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const out = buffered.slice(0, end + 2);
        buffered = buffered.slice(end + 2);
        return out;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value);
    }
  };
  const first = (await frame())!;
  const own = (await frame())!;
  const id = /^id:(\w+)\n/.exec(first)![1]!;
  return {
    reader,
    first,
    own,
    id,
    client: app.realtime.clientById(id)!,
    frame,
  };
}

// sends a message and waits for the loop to write it and reset its idle timer
async function roundTrip(conn: Awaited<ReturnType<typeof connect>>) {
  conn.client.send({ name: "ping", data: "{}" });
  expect(await conn.frame()).toBe(`id:${conn.id}\nevent:ping\ndata:{}\n\n`);
  await tick();
}

describe("broker", () => {
  test("client ids are 40 alphanumeric characters", () => {
    const a = new Client();
    expect(a.id).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(new Client().id).not.toBe(a.id);
  });

  test("topic options are parsed, stringified and snake_cased", () => {
    const c = new Client();
    const options = encodeURIComponent(
      JSON.stringify({
        query: { filter: "a=1", n: 5, b: true, o: { x: 1 }, z: null },
        headers: { "X-Token": "t", xApiKey: "k" },
      }),
    );
    c.subscribe(`posts/*?options=${options}`, "posts?options=bad", "", "a");
    expect([...c.subscriptions().keys()]).toEqual([
      `posts/*?options=${options}`,
      "posts?options=bad",
      "a",
    ]);
    expect(
      c.subscriptions("posts/*?").get(`posts/*?options=${options}`),
    ).toEqual({
      query: { filter: "a=1", n: "5", b: "true", o: "", z: "" },
      headers: { x_token: "t", x_api_key: "k" },
    });
    expect(c.subscriptions("posts?").get("posts?options=bad")).toEqual({
      query: {},
      headers: {},
    });
    expect(c.subscriptions("a?").size).toBe(1);
    const partial = `p?options=${encodeURIComponent('{"query":{"a":"1"},"headers":5}')}`;
    c.subscribe(partial);
    expect(c.subscriptions().get(partial)).toEqual({
      query: { a: "1" },
      headers: {},
    });
    c.unsubscribe("a");
    expect(c.hasSubscription("a")).toBe(false);
    c.unsubscribe();
    expect(c.subscriptions().size).toBe(0);
  });
});

describe("connection", () => {
  test("frames are byte exact", async () => {
    const conn = await connect();
    expect(conn.first).toBe(
      `id:${conn.id}\nevent:PB_CONNECT\ndata:{"clientId":"${conn.id}"}\n\n`,
    );
    expect(conn.own).toBe(
      `id:${conn.id}\nevent:HB_CONNECT\ndata:{"clientId":"${conn.id}"}\n\n`,
    );
    expect(conn.client.get(IP_KEY)).toBe("9.9.9.9");
    conn.client.send({ name: "posts/*", data: '{"a":1}' });
    expect(await conn.frame()).toBe(
      `id:${conn.id}\nevent:posts/*\ndata:{"a":1}\n\n`,
    );
  });

  test("the idle timeout closes after 5 minutes without messages and a message pushes it back", async () => {
    const conn = await connect();
    clock.advance(299_999);
    await roundTrip(conn);
    clock.advance(299_999);
    await roundTrip(conn);
    clock.advance(299_999);
    expect(app.realtime.clientById(conn.id)).not.toBeNull();
    clock.advance(1);
    expect(await conn.frame()).toBeNull();
    expect(app.realtime.clientById(conn.id)).toBeNull();
    expect(conn.client.isDiscarded()).toBe(true);
  });

  test("the max timeout closes at 30 minutes despite traffic", async () => {
    const conn = await connect();
    for (let i = 0; i < 7; i++) {
      clock.advance(240_000);
      await roundTrip(conn);
    }
    clock.advance(119_999);
    expect(app.realtime.clientById(conn.id)).not.toBeNull();
    clock.advance(1);
    expect(await conn.frame()).toBeNull();
    expect(app.realtime.clientById(conn.id)).toBeNull();
  });

  test("a cancelled body unregisters the client", async () => {
    const conn = await connect();
    await conn.reader.cancel();
    await tick();
    expect(app.realtime.clientById(conn.id)).toBeNull();
  });
});

describe("broadcast", () => {
  test("a delete in a transaction whose enrich hook writes completes and broadcasts", async () => {
    await app.collections.save({
      name: "notes",
      listRule: "",
      fields: [{ name: "title", type: "text" }],
    } as never);
    await app.collections.save({
      name: "log",
      fields: [{ name: "title", type: "text" }],
    } as never);
    const note = (await app.records("notes").create({ title: "n" })) as {
      id: string;
    };
    const client = new Client();
    client.subscribe("notes/*");
    app.realtime.register(client);
    app.onRecordEnrich("notes", async (e) => {
      await app.records("log").create({ title: "enriched" });
      return e.next();
    });
    // inside a transaction, as in a batch
    await app.db.write(() => app.records("notes").delete(note.id));
    const m = (await client.receive())!;
    expect(m.name).toBe("notes/*");
    expect(JSON.parse(m.data)).toMatchObject({
      action: "delete",
      record: { id: note.id },
    });
    expect(app.db.query("SELECT id FROM log")).toHaveLength(1);
  });
});

describe("client auth state", () => {
  let user: Record<string, unknown>;
  let client: Client;
  const users = () => app.collections.find("users")!;
  const authOf = (c: Client) => c.get(AUTH_KEY) as AuthState | undefined;

  beforeEach(async () => {
    user = (await app
      .records("users")
      .create({ email: "a@example.com", password: "12345678" })) as Record<
      string,
      unknown
    >;
    client = new Client();
    app.realtime.register(client);
    client.set(AUTH_KEY, {
      record: internalRecords(app, "users").findRaw(user.id as string),
      collection: users(),
      isSuperuser: false,
    } satisfies AuthState);
  });

  test("an update of the auth record refreshes it, a new token key unsets it", async () => {
    await app.records("users").update(user.id as string, { name: "New" });
    expect(authOf(client)!.record.name).toBe("New");
    await app
      .records("users")
      .update(user.id as string, { password: "87654321" });
    expect(authOf(client)).toBeUndefined();
  });

  test("a deleted auth record unsets it", async () => {
    await app.records("users").delete(user.id as string);
    expect(authOf(client)).toBeUndefined();
    expect(app.realtime.clientById(client.id)).toBe(client);
  });

  test("a changed collection token secret unsets it", async () => {
    await app.collections.save({ id: users().id, listRule: "" } as never);
    expect(authOf(client)).toBeDefined();
    await app.collections.save({
      id: users().id,
      authToken: { ...(users().authToken as object), secret: "x".repeat(50) },
    } as never);
    expect(authOf(client)).toBeUndefined();
  });

  test("a deleted auth collection unsets it", async () => {
    await app.collections.delete(users().id);
    expect(authOf(client)).toBeUndefined();
  });
});

describe("oauth2 redirect", () => {
  function oauth2Client(ip = "9.9.9.9") {
    const client = new Client();
    client.set(IP_KEY, ip);
    client.subscribe("@oauth2");
    app.realtime.register(client);
    return client;
  }

  const appleRedirect = (state: string, code: string) =>
    call(
      new Request("http://x/api/oauth2-redirect", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          state,
          code,
          user: JSON.stringify({
            name: { firstName: " Ada", lastName: "Lovelace " },
          }),
        }),
      }),
    );

  test("the Apple user name is kept for 60 seconds and taken once", async () => {
    const client = oauth2Client();
    const res = await appleRedirect(client.id, "c1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "../_/#/auth/oauth2-redirect-success",
    );
    expect(await client.receive()).toEqual({
      name: "@oauth2",
      data: `{"state":"${client.id}","code":"c1"}`,
    });
    expect(client.hasSubscription("@oauth2")).toBe(false);
    clock.advance(59_999);
    expect(takeAppleName(app, "c1")).toBe("Ada Lovelace");
    expect(takeAppleName(app, "c1")).toBeUndefined();

    await appleRedirect(oauth2Client().id, "c2");
    clock.advance(60_000);
    expect(takeAppleName(app, "c2")).toBeUndefined();
  });

  test("an IP mismatch fails without sending or keeping anything", async () => {
    const client = oauth2Client("1.1.1.1");
    const res = await appleRedirect(client.id, "c3");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "../_/#/auth/oauth2-redirect-failure",
    );
    expect(client.hasSubscription("@oauth2")).toBe(false);
    client.send({ name: "marker", data: "" });
    expect((await client.receive())!.name).toBe("marker");
    expect(takeAppleName(app, "c3")).toBeUndefined();
  });
});
