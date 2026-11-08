import { afterEach, describe, expect, test } from "bun:test";
import { memoryStore } from "./auth-store.js";
import { createClientWith } from "./client.js";
import { HeybeError } from "./error.js";
import { fakeEnv, jwt, sseStream } from "./test-env.js";

const base = "http://a/api/collections/users";
const user = { id: "u1", collectionId: "c", collectionName: "users" };
const token = jwt({ id: "u1", collectionId: "c", exp: 9e9 });
const AUTH_URL =
  "http://p/auth?client_id=cid&response_type=code&scope=openid&state=abc&redirect_uri=";

function setup() {
  const env = fakeEnv();
  const client = createClientWith(
    "http://a",
    { authStore: memoryStore() },
    env,
  );
  const streams: ReturnType<typeof sseStream>[] = [];
  env.respond((req) => {
    const url = req.url;
    if (url === `${base}/auth-methods?fields=mfa%2Cotp%2Cpassword%2Coauth2`)
      return Response.json({
        oauth2: {
          enabled: true,
          providers: [
            {
              name: "google",
              displayName: "Google",
              state: "abc",
              authURL: AUTH_URL,
              codeVerifier: "verifier",
              codeChallenge: "challenge",
              codeChallengeMethod: "S256",
            },
          ],
        },
      });
    if (req.method === "GET" && url === "http://a/api/realtime") {
      const stream = sseStream();
      streams.push(stream);
      return stream.response;
    }
    if (url.startsWith(`${base}/auth-with-oauth2`))
      return Response.json({ token, record: user });
    return new Response(null, { status: 204 });
  });
  const urls: string[] = [];
  const stream = () => streams.at(-1)!;
  const users = client.auth("users");
  return {
    env,
    client,
    streams,
    urls,
    stream,
    users,
    exchanges: () =>
      env.requests.filter((r) => r.url.startsWith(`${base}/auth-with-oauth2`)),
    start(config: Partial<Parameters<typeof users.withOAuth2>[0]> = {}) {
      const result = users
        .withOAuth2({
          provider: "google",
          urlCallback: (url) => void urls.push(url),
          ...config,
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error: HeybeError) => ({ value: undefined, error }),
        );
      return result;
    },
    async connect(id = "c1") {
      await env.advance(0);
      stream().push(
        `id:${id}\nevent:PB_CONNECT\ndata:{"clientId":"${id}"}\n\n`,
      );
      await env.advance(0);
    },
    async emit(data: unknown) {
      stream().push(`event:@oauth2\ndata:${JSON.stringify(data)}\n\n`);
      await env.advance(0);
    },
  };
}

const redirect = encodeURIComponent("http://a/api/oauth2-redirect");

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("withOAuth2", () => {
  test("urlCallback gets the auth URL with state and scope replaced", async () => {
    const t = setup();
    void t.start({ scopes: ["email", "profile"] });
    await t.connect("c1");
    expect(t.urls).toEqual([
      `http://p/auth?client_id=cid&response_type=code&scope=email%20profile&state=c1&redirect_uri=${redirect}`,
    ]);
    const subscribe = t.env.requests.find(
      (r) => r.method === "POST" && r.url === "http://a/api/realtime",
    );
    expect(JSON.parse(subscribe!.body as string)).toEqual({
      clientId: "c1",
      subscriptions: ["@oauth2"],
    });
  });

  test("matching @oauth2 event exchanges the code with the provider's codeVerifier and redirectURL and saves the store", async () => {
    const t = setup();
    const result = t.start({
      createData: { name: "x" },
      expand: { team: true },
    });
    await t.connect("c1");
    expect(t.urls[0]).toContain("scope=openid&state=c1&");
    await t.emit({ state: "c1", code: "the-code" });
    const { value } = await result;
    expect(value).toEqual({ token, record: user } as never);
    expect(t.exchanges()).toHaveLength(1);
    expect(t.exchanges()[0]!.url).toBe(`${base}/auth-with-oauth2?expand=team`);
    expect(JSON.parse(t.exchanges()[0]!.body as string)).toEqual({
      provider: "google",
      code: "the-code",
      codeVerifier: "verifier",
      redirectURL: "http://a/api/oauth2-redirect",
      createData: { name: "x" },
    });
    expect(t.client.authStore.token).toBe(token);
  });

  test("state mismatch rejects", async () => {
    const t = setup();
    const result = t.start();
    await t.connect("c1");
    await t.emit({ state: "other", code: "the-code" });
    const { error } = await result;
    expect(error).toBeInstanceOf(HeybeError);
    expect(error!.message).toBe("State parameters don't match.");
    expect(t.exchanges()).toHaveLength(0);
  });

  test("error in event rejects", async () => {
    const t = setup();
    const result = t.start();
    await t.connect("c1");
    await t.emit({ state: "c1", code: "x", error: "denied" });
    const { error } = await result;
    expect(error!.message).toBe(
      "OAuth2 redirect error or missing code: denied",
    );
    expect(t.exchanges()).toHaveLength(0);
  });

  test("missing code rejects", async () => {
    const t = setup();
    const result = t.start();
    await t.connect("c1");
    await t.emit({ state: "c1" });
    const { error } = await result;
    expect(error!.message).toBe(
      "OAuth2 redirect error or missing code: undefined",
    );
  });

  test("unknown provider rejects", async () => {
    const t = setup();
    const { error } = await t.start({ provider: "nope" });
    expect(error).toBeInstanceOf(HeybeError);
    expect(error!.message).toBe('Missing or invalid provider "nope".');
    expect(t.streams).toHaveLength(0);
  });

  test("no urlCallback outside a browser rejects", async () => {
    const t = setup();
    const { error } = await t.start({ urlCallback: undefined });
    expect(error).toBeInstanceOf(HeybeError);
    expect(error!.message).toBe(
      "Not in a browser context - please pass a custom urlCallback function.",
    );
    expect(t.env.requests).toHaveLength(0);
  });

  test("in a browser the popup opens before any request and closes after the flow", async () => {
    const t = setup();
    const popup = { location: { href: "" }, closed: false, close() {} };
    const opened: unknown[][] = [];
    popup.close = () => void (popup.closed = true);
    (globalThis as { window?: unknown }).window = {
      innerWidth: 800,
      innerHeight: 1000,
      open: (...args: unknown[]) => {
        opened.push([...args, t.env.requests.length]);
        return popup;
      },
    };
    const result = t.start({ urlCallback: undefined });
    expect(opened).toEqual([
      [
        undefined,
        "popup_window",
        "width=800,height=768,top=116,left=0,resizable,menubar=no",
        0,
      ],
    ]);
    await t.connect("c1");
    expect(popup.location.href).toContain("state=c1&");
    expect(popup.closed).toBe(false);
    await t.emit({ state: "c1", code: "the-code" });
    expect((await result).value?.token).toBe(token);
    expect(popup.closed).toBe(true);
  });

  test("stream loss rejects with realtime connection interrupted", async () => {
    const t = setup();
    const result = t.start();
    await t.connect("c1");
    t.stream().end();
    await t.env.advance(0);
    const { error } = await result;
    expect(error!.message).toBe("realtime connection interrupted");
    await t.env.advance(10_000);
    expect(t.streams).toHaveLength(1);
  });

  test("signal abort rejects with isAbort", async () => {
    const t = setup();
    const controller = new AbortController();
    const result = t.start({ signal: controller.signal });
    await t.connect("c1");
    controller.abort();
    const { error } = await result;
    expect(error!.isAbort).toBe(true);
    expect(error!.message).toBe("manually cancelled");
    await t.env.advance(0);
    expect(t.stream().cancelled).toBe(true);
    expect(t.exchanges()).toHaveLength(0);
  });

  test("the realtime connection is closed after success and after failure", async () => {
    for (const data of [
      { state: "c1", code: "the-code" },
      { state: "c1", error: "denied" },
    ]) {
      const t = setup();
      const result = t.start();
      await t.connect("c1");
      await t.emit(data);
      await result;
      await t.env.advance(0);
      expect(t.stream().cancelled).toBe(true);
      expect(t.client.realtime.isConnected).toBe(false);
      await t.env.advance(10_000);
      expect(
        t.env.requests.filter((r) => r.url === "http://a/api/realtime"),
      ).toHaveLength(2);
    }
  });

  test("abort before PB_CONNECT calls no urlCallback", async () => {
    const t = setup();
    const controller = new AbortController();
    const result = t.start({ signal: controller.signal });
    await t.env.advance(0);
    controller.abort();
    expect((await result).error!.isAbort).toBe(true);
    await t.env.advance(0);
    expect(t.urls).toEqual([]);
    expect(t.stream().cancelled).toBe(true);
  });

  test("abort before PB_CONNECT in a browser closes the only popup", async () => {
    const t = setup();
    const popups: { location: { href: string }; closed: boolean }[] = [];
    (globalThis as { window?: unknown }).window = {
      innerWidth: 1280,
      innerHeight: 800,
      open() {
        const popup = { location: { href: "" }, closed: false };
        popups.push(popup);
        return { ...popup, close: () => void (popup.closed = true) };
      },
    };
    const controller = new AbortController();
    const result = t.start({
      urlCallback: undefined,
      signal: controller.signal,
    });
    await t.env.advance(0);
    controller.abort();
    await result;
    await t.env.advance(0);
    expect(popups).toEqual([{ location: { href: "" }, closed: true }]);
  });

  test("two flows at once both succeed", async () => {
    const t = setup();
    const a = t.start();
    await t.env.advance(0);
    const b = t.start();
    await t.env.advance(0);
    const [sa, sb] = t.streams;
    sa!.push(`id:c1\nevent:PB_CONNECT\ndata:{"clientId":"c1"}\n\n`);
    sb!.push(`id:c2\nevent:PB_CONNECT\ndata:{"clientId":"c2"}\n\n`);
    await t.env.advance(0);
    sa!.push(`event:@oauth2\ndata:{"state":"c1","code":"x1"}\n\n`);
    await t.env.advance(0);
    expect((await a).value?.token).toBe(token);
    sb!.push(`event:@oauth2\ndata:{"state":"c2","code":"x2"}\n\n`);
    await t.env.advance(0);
    expect((await b).value?.token).toBe(token);
    expect(t.streams).toHaveLength(2);
  });

  test("a flow while client.realtime is connected", async () => {
    const t = setup();
    void t.client.realtime.subscribe("posts/*", () => {});
    await t.connect("m1");
    const result = t.start();
    await t.connect("c1");
    expect(t.urls[0]).toContain("state=c1&");
    expect(t.client.realtime.clientId).toBe("m1");
    await t.emit({ state: "c1", code: "the-code" });
    expect((await result).value?.token).toBe(token);
    await t.env.advance(0);
    expect(t.streams[1]!.cancelled).toBe(true);
    // the login reconnects client.realtime under the new token, the flow's stream stays closed
    expect(t.streams).toHaveLength(3);
    expect(t.streams[0]!.cancelled).toBe(true);
    expect(t.streams[2]!.cancelled).toBe(false);
  });

  test("the flow uses its own realtime connection", async () => {
    const t = setup();
    void t.start();
    await t.connect("c1");
    expect(t.client.realtime.clientId).toBe("");
  });
});
