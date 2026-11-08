import { generateKeyPairSync as generateKeyPair } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

const PASSWORD = "12345678";
type Ids = Record<Target["name"], string>;

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
): Promise<void> {
  const [pb, hb] = await both(fn);
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
}

const ids = {} as { user: Ids; other: Ids; userToken: Ids };

beforeAll(async () => {
  targets = await startTargets();
  await both((t) =>
    api(t, "POST", "/api/collections", { name: "members", type: "auth" }),
  );
  for (const [key, email] of [
    ["user", "user@example.com"],
    ["other", "other@example.com"],
  ] as const) {
    ids[key] = {} as Ids;
    await both(async (t) => {
      const res = await api(t, "POST", "/api/collections/members/records", {
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      });
      ids[key][t.name] = ((await res.clone().json()) as { id: string }).id;
      return res;
    });
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

const impersonate = (
  t: Target,
  id: string,
  body?: unknown,
  token?: string | null,
) => api(t, "POST", `/api/collections/members/impersonate/${id}`, body, token);

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
    exp: number;
    refreshable: boolean;
    type: string;
  };

describe("impersonate", () => {
  test("superuser without duration", async () => {
    await same((t) => impersonate(t, ids.user[t.name], {}), 200);
  });

  test("superuser with duration", async () => {
    await same((t) => impersonate(t, ids.user[t.name], { duration: 100 }), 200);
  });

  test("token is non-refreshable with the requested duration", async () => {
    const tokens = {} as Ids;
    await both(async (t) => {
      const res = await impersonate(t, ids.user[t.name], { duration: 100 });
      tokens[t.name] = ((await res.clone().json()) as { token: string }).token;
      return res;
    });
    for (const name of ["pocketbase", "heybe"] as const) {
      const c = claims(tokens[name]);
      expect(c.refreshable).toBe(false);
      expect(c.type).toBe("auth");
      expect(Math.abs(c.exp - Date.now() / 1000 - 100)).toBeLessThan(30);
    }
    ids.userToken = tokens as Ids;
  });

  test("impersonate token is authorized and cannot be refreshed", async () => {
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/members/auth-refresh",
          undefined,
          ids.userToken[t.name],
        ),
      200,
    );
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(
        t,
        "POST",
        "/api/collections/members/auth-refresh",
        undefined,
        ids.userToken[t.name],
      );
      expect(((await res.json()) as { token: string }).token).toBe(
        ids.userToken[t.name],
      );
    }
  });

  test("impersonating a superuser", async () => {
    const su = {} as Ids;
    await both(async (t) => {
      const res = await api(t, "GET", "/api/collections/_superusers/records");
      su[t.name] = (
        (await res.clone().json()) as { items: { id: string }[] }
      ).items[0]!.id;
      return res;
    });
    await same(
      (t) =>
        api(
          t,
          "POST",
          `/api/collections/_superusers/impersonate/${su[t.name]}`,
          {},
        ),
      200,
    );
  });

  test("non-superuser and guest are forbidden", async () => {
    await same(
      (t) => impersonate(t, ids.other[t.name], {}, ids.userToken[t.name]),
      403,
    );
    await same((t) => impersonate(t, ids.other[t.name], {}, null), 401);
  });

  test("unknown record and collection", async () => {
    await same((t) => impersonate(t, "missingrecord1", {}), 404);
    await same(
      (t) =>
        api(
          t,
          "POST",
          `/api/collections/nope/impersonate/${ids.user[t.name]}`,
          {},
        ),
      404,
    );
    await same(
      (t) =>
        api(t, "POST", `/api/collections/_pb_users_auth_/impersonate/x`, {}),
      404,
    );
  });

  test("invalid duration and body", async () => {
    await same((t) => impersonate(t, ids.user[t.name], { duration: -1 }), 400);
    await same((t) => impersonate(t, ids.user[t.name], { duration: "x" }), 400);
    await same((t) => impersonate(t, ids.user[t.name], { duration: 1.5 }), 400);
  });
});

describe("apple client secret", () => {
  const path = "/api/settings/apple/generate-client-secret";
  const key = [
    "-----BEGIN PRIVATE KEY-----",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const valid = {
    clientId: "com.example.app",
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: key,
    duration: 3600,
  };

  test("requires a superuser", async () => {
    await same((t) => api(t, "POST", path, valid, null), 401);
  });

  test("validation errors", async () => {
    await same((t) => api(t, "POST", path, {}), 400);
    await same(
      (t) =>
        api(t, "POST", path, {
          clientId: "x",
          teamId: "short",
          keyId: "waytoolongkeyid",
          privateKey: "nope",
          duration: 15777001,
        }),
      400,
    );
    await same((t) => api(t, "POST", path, { ...valid, duration: -5 }), 400);
  });

  test("invalid json body", async () => {
    await same((t) => api(t, "POST", path, { ...valid, duration: "x" }), 400);
  });

  test("unparsable private key", async () => {
    const [pb, hb] = await both((t) => api(t, "POST", path, valid));
    for (const r of [pb, hb]) {
      expect(r.status).toBe(400);
      expect((r.body as { message: string }).message).toStartWith(
        "Failed to generate client secret. Raw error:",
      );
    }
  });

  test("generated secret has the same header and claims", async () => {
    const pem = generateKeyPair("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const decoded = {} as Record<Target["name"], unknown[]>;
    await both(async (t) => {
      const res = await api(t, "POST", path, { ...valid, privateKey: pem });
      const { secret } = (await res.clone().json()) as { secret: string };
      const [h, c] = secret.split(".");
      const parse = (s: string) =>
        JSON.parse(Buffer.from(s, "base64url").toString());
      decoded[t.name] = [parse(h!), parse(c!), Object.keys(parse(c!))];
      return res;
    });
    const [pbClaims, hbClaims] = [decoded.pocketbase[1], decoded.heybe[1]] as {
      exp: number;
      iat: number;
    }[];
    expect(decoded.heybe[0]).toEqual(decoded.pocketbase[0]);
    expect(decoded.heybe[2]).toEqual(decoded.pocketbase[2]);
    expect({ ...hbClaims, iat: 0, exp: hbClaims!.exp - hbClaims!.iat }).toEqual(
      { ...pbClaims, iat: 0, exp: pbClaims!.exp - pbClaims!.iat },
    );
  });
});
