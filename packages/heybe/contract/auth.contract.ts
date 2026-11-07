import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

beforeAll(async () => {
  targets = await startTargets();
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

const base = (t: Target) => `${t.url}/api/collections/_superusers`;

const login = (t: Target, body: unknown) =>
  fetch(`${base(t)}/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const refresh = (t: Target, authorization?: string) =>
  fetch(`${base(t)}/auth-refresh`, {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });

describe("auth-with-password", () => {
  test("succeeds with the superuser credentials", async () => {
    const [pb, hb] = await both((t) =>
      login(t, { identity: "test@example.com", password: "1234567890" }),
    );
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
  });

  test("matches the identity case-insensitively like PB", async () => {
    const [pb, hb] = await both((t) =>
      login(t, { identity: "TEST@example.com", password: "1234567890" }),
    );
    expectSame(pb, hb);
  });

  test("wrong password", async () => {
    const [pb, hb] = await both((t) =>
      login(t, { identity: "test@example.com", password: "wrongpassword" }),
    );
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("unknown identity", async () => {
    const [pb, hb] = await both((t) =>
      login(t, { identity: "nobody@example.com", password: "1234567890" }),
    );
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("missing fields", async () => {
    const [pb, hb] = await both((t) => login(t, {}));
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("invalid identityField and too long identity", async () => {
    const [pb, hb] = await both((t) =>
      login(t, {
        identity: "a".repeat(256),
        password: "x",
        identityField: "username",
      }),
    );
    expect(pb.status).toBe(400);
    expectSame(pb, hb);
  });

  test("unknown collection", async () => {
    const [pb, hb] = await both((t) =>
      fetch(`${t.url}/api/collections/nope/auth-with-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: "a", password: "b" }),
      }),
    );
    expect(pb.status).toBe(404);
    expectSame(pb, hb);
  });
});

describe("auth-refresh", () => {
  test("returns the record and a new token", async () => {
    const [pb, hb] = await both((t) => refresh(t, t.superToken));
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
  });

  test("accepts a Bearer prefix", async () => {
    const [pb, hb] = await both((t) => refresh(t, `Bearer ${t.superToken}`));
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
  });

  test("garbage Authorization header", async () => {
    const [pb, hb] = await both((t) => refresh(t, "garbage"));
    expect(pb.status).toBe(401);
    expectSame(pb, hb);
  });

  test("unknown collection without a token is 404", async () => {
    const [pb, hb] = await both((t) =>
      fetch(`${t.url}/api/collections/nope/auth-refresh`, { method: "POST" }),
    );
    expect(pb.status).toBe(404);
    expectSame(pb, hb);
  });

  test("missing Authorization header", async () => {
    const [pb, hb] = await both((t) => refresh(t));
    expect(pb.status).toBe(401);
    expectSame(pb, hb);
  });
});

describe("tokens", () => {
  test("claims and duration match PB", async () => {
    const claims = (t: Target) => {
      const [head, payload] = t.superToken.split(".");
      const body = JSON.parse(Buffer.from(payload!, "base64url").toString());
      return {
        head: Buffer.from(head!, "base64url").toString(),
        keys: Object.keys(body),
        ttl: body.exp - Math.floor(Date.now() / 1000),
        body: { ...body, exp: 0, id: 0 },
      };
    };
    const a = claims(targets.pb);
    const b = claims(targets.hb);
    expect(b.head).toBe(a.head);
    expect(b.keys).toEqual(a.keys);
    expect(Math.abs(b.ttl - a.ttl)).toBeLessThan(30);
    expect(b.body.type).toBe(a.body.type);
    expect(b.body.refreshable).toBe(a.body.refreshable);
  });
});

describe("auth-methods", () => {
  test("body", async () => {
    const [pb, hb] = await both((t) => fetch(`${base(t)}/auth-methods`));
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
  });

  test("unknown collection", async () => {
    const [pb, hb] = await both((t) =>
      fetch(`${t.url}/api/collections/nope/auth-methods`),
    );
    expect(pb.status).toBe(404);
    expectSame(pb, hb);
  });
});
