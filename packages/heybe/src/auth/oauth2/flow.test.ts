import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  type OAuth2Mock,
  startOAuth2Mock,
} from "../../../contract/oauth2-mock";
import { type App, createApp } from "../../app";
import type { RequestInfo } from "../../filter/compile";
import { ApiError } from "../../http/errors";
import {
  authWithOAuth2,
  buildAuthURL,
  initProvider,
  isPublicIp,
  safeFileFromURL,
} from "./flow";
import { readText } from "./http";
import { validateTokenSignature } from "./jwk";

let mock: OAuth2Mock;
let app: App;
const clock = new Date("2026-01-01T00:00:00Z");
const info: RequestInfo = {
  auth: null,
  authCollection: null,
  body: {},
  query: {},
  headers: {},
  method: "POST",
  context: "oauth2",
};
const allowAll = { allowIp: () => true };

beforeAll(() => {
  mock = startOAuth2Mock();
});
afterAll(() => mock.stop());

const users = () => app.collections.find("users")!;

beforeEach(async () => {
  app = createApp({ dir: ":memory:", now: () => clock });
  const provider = (name: string, extra: object = {}) => ({
    name,
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    authURL: `${mock.url}/authorize`,
    tokenURL: `${mock.url}/token`,
    ...extra,
  });
  await app.collections.save({
    id: users().id,
    oauth2: {
      ...(users().oauth2 as object),
      enabled: true,
      providers: [
        provider("google", { userInfoURL: `${mock.url}/userinfo` }),
        provider("oidc", { extra: { jwksURL: `${mock.url}/jwks` } }),
      ],
    },
  } as any);
});
afterEach(() => app.close());

const login = (
  code: string,
  provider = "google",
  opts: { allowIp?: (ip: string) => boolean } = allowAll,
) =>
  authWithOAuth2(
    app,
    users(),
    { provider, code, codeVerifier: "", redirectURL: "" },
    null,
    info,
    opts,
  );

const failure = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (err: ApiError) => ({
      status: err.status,
      message: err.message,
      data: err.data,
    }),
  );

const countUsers = () =>
  app.db.get<{ n: number }>("SELECT count(*) AS n FROM users")!.n;
const countLinks = () =>
  app.db.get<{ n: number }>("SELECT count(*) AS n FROM _externalAuths")!.n;

describe("avatar", () => {
  test("is downloaded into the mapped file field through the upload path", async () => {
    mock.set("av", {
      user: {
        sub: "g1",
        name: "Ann",
        email: "ann@example.com",
        email_verified: true,
        picture: mock.avatarURL,
      },
    });
    const { record, meta } = await login("av");
    expect(record.name).toBe("Ann");
    expect(record.verified).toBe(true);
    expect(meta.expiry).toBe("2026-01-01 01:00:00.000Z");
    expect(meta.isNew).toBe(true);
    const name = record.avatar as string;
    expect(name).toMatch(/^avatar_\w{10}\.png$/);
    const stored = await app.files.file(`${users().id}/${record.id}/${name}`);
    expect(stored?.size).toBeGreaterThan(0);
  });

  test("a loopback address is refused by default and the record is still created", async () => {
    await expect(safeFileFromURL(mock.avatarURL)).rejects.toThrow("disallowed");
    mock.set("av-local", {
      user: {
        sub: "g2",
        email: "bo@example.com",
        email_verified: true,
        picture: mock.avatarURL,
      },
    });
    const { record } = await login("av-local", "google", {});
    expect(record.avatar).toBe("");
  });

  test("a failure after the upload keeps neither the record nor the file", async () => {
    const writes: string[] = [];
    const write = app.files.write.bind(app.files);
    app.files.write = async (key, data) => {
      writes.push(key);
      return write(key, data);
    };
    // no provider id: the external auth fails validation after the record insert
    mock.set("no-id", {
      user: {
        email: "cy@example.com",
        email_verified: true,
        picture: mock.avatarURL,
      },
    });
    expect(await failure(login("no-id"))).toEqual({
      status: 400,
      message: "Failed to authenticate.",
      data: {
        providerId: {
          code: "validation_required",
          message: "Cannot be blank.",
        },
      },
    });
    expect(countUsers()).toBe(0);
    expect(countLinks()).toBe(0);
    expect(writes).toHaveLength(1);
    expect(await app.files.file(writes[0]!)).toBeNull();
  });
});

describe("isPublicIp", () => {
  test.each([
    ["127.0.0.1", false],
    ["0.0.0.0", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.1.1", false],
    ["224.0.0.1", false],
    ["::1", false],
    ["::", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["::ffff:127.0.0.1", false],
    ["8.8.8.8", true],
    ["172.32.0.1", true],
    ["2001:4860:4860::8888", true],
  ])("%s", (ip, expected) => expect(isPublicIp(ip)).toBe(expected));
});

describe("buildAuthURL", () => {
  test("encodes like Go's url.Values", () => {
    const p = initProvider({
      name: "google",
      clientId: "id!*~",
      authURL: "https://x/auth?a=1",
    })!;
    p.scopes = ["read user", "x"];
    expect(buildAuthURL(p, "st", { code_challenge: "c(1)" })).toBe(
      "https://x/auth?a=1&client_id=id%21%2A~&code_challenge=c%281%29&response_type=code&scope=read+user+x&state=st",
    );
  });
});

describe("oidc id_token", () => {
  let keys: CryptoKeyPair;
  beforeAll(async () => {
    keys = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    mock.setJwks([{ kty: "RSA", kid: "k1", alg: "RS256", n: jwk.n, e: jwk.e }]);
  });

  const b64 = (v: object) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  async function idToken(claims: object): Promise<string> {
    const input = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  }
  const iat = clock.getTime() / 1000;
  const claims = {
    sub: "o1",
    email: "olga@example.com",
    email_verified: "true",
    aud: "client-id",
    iat,
    exp: iat + 600,
  };

  test("a signed token for this client is used as the user info", async () => {
    mock.set("id-ok", { user: {}, idToken: await idToken(claims) });
    const { record, meta } = await login("id-ok", "oidc");
    expect(meta.id).toBe("o1");
    expect(record.email).toBe("olga@example.com");
  });

  test.each([
    ["another audience", { ...claims, aud: "other" }, false],
    ["expired", { ...claims, exp: iat - 600 }, false],
    ["a bad signature", claims, true],
  ])("%s fails", async (_, body, tamper) => {
    let token = await idToken(body);
    if (tamper)
      token = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    mock.set("id-bad", { user: {}, idToken: token });
    expect(await failure(login("id-bad", "oidc"))).toEqual({
      status: 400,
      message: "Failed to fetch OAuth2 user.",
      data: {},
    });
    expect(countUsers()).toBe(0);
  });
});

describe("external auth links", () => {
  async function linkedUser(): Promise<Record<string, unknown>> {
    const user = await app
      .records("users")
      .create({ email: "dee@example.com", password: "12345678" });
    await app.records("_externalAuths").create({
      collectionRef: users().id,
      recordRef: user.id,
      provider: "github",
      providerId: "1",
    });
    return app.records("users").findRaw(user.id as string);
  }

  test("are dropped with a new tokenKey when the record becomes verified", async () => {
    const user = await linkedUser();
    await app.records("users").update(user.id as string, { verified: true });
    expect(countLinks()).toBe(0);
    expect(app.records("users").findRaw(user.id as string).tokenKey).not.toBe(
      user.tokenKey,
    );
  });

  test("are deleted with their record", async () => {
    const user = await linkedUser();
    await app.records("users").delete(user.id as string);
    expect(countLinks()).toBe(0);
  });
});

describe("safeFileFromURL", () => {
  test("connects only to the address it checked (no DNS rebinding)", async () => {
    let hits = 0;
    const counter = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++;
        return new Response("x");
      },
    });
    // first answer passes the check (and refuses the connection), a second lookup would reach loopback
    const answers = ["::1", "127.0.0.1"];
    let calls = 0;
    const resolve = async () => [
      { address: answers[calls++]!, family: calls === 1 ? 6 : 4 },
    ];
    try {
      await expect(
        safeFileFromURL(`http://localhost:${counter.port}/a.png`, {
          allowIp: (ip) => ip !== "127.0.0.1",
          resolve,
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect(hits).toBe(0);
    } finally {
      await counter.stop(true);
    }
  });

  test("a disallowed lookup answer is refused before connecting", async () => {
    await expect(
      safeFileFromURL(`http://localhost:1/a.png`, {
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      }),
    ).rejects.toThrow("disallowed");
  });

  test.each([
    "file:///etc/passwd",
    "ftp://example.com/a.png",
    "data:image/png;base64,AA==",
  ])("%s is refused", async (url) => {
    await expect(safeFileFromURL(url, allowAll)).rejects.toThrow("scheme");
  });

  test("a redirect to another scheme is refused", async () => {
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect("file:///etc/passwd", 302),
    });
    try {
      await expect(
        safeFileFromURL(`${redirect.url}a.png`, allowAll),
      ).rejects.toThrow("scheme");
    } finally {
      await redirect.stop(true);
    }
  });

  test("follows redirects and keeps the first URL's name", async () => {
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(mock.avatarURL, 302),
    });
    try {
      const file = await safeFileFromURL(`${redirect.url}me.png`, allowAll);
      expect(file.name).toBe("me.png");
      expect(file.size).toBeGreaterThan(0);
    } finally {
      await redirect.stop(true);
    }
  });
});

describe("existing record decisions", () => {
  test("a record verified between the read and the write keeps its password and links", async () => {
    const user = await app
      .records("users")
      .create({ email: "eve@example.com", password: "12345678" });
    await app.records("_externalAuths").create({
      collectionRef: users().id,
      recordRef: user.id,
      provider: "github",
      providerId: "1",
    });
    const hash = Bun.password.hash;
    // the record becomes verified while the random password is hashed
    const spy = spyOn(Bun.password, "hash").mockImplementation(
      async (...args: Parameters<typeof hash>) => {
        app.db.run("UPDATE users SET verified = 1 WHERE id = ?", [
          user.id as string,
        ]);
        return hash(...args);
      },
    );
    mock.set("eve", {
      user: { sub: "g-eve", email: "eve@example.com", email_verified: true },
    });
    try {
      const { record } = await login("eve");
      expect(record.id).toBe(user.id);
    } finally {
      spy.mockRestore();
    }
    const saved = app.records("users").findRaw(user.id as string);
    expect(
      await Bun.password.verify(
        "12345678",
        (saved.password as { hash: string }).hash,
      ),
    ).toBe(true);
    expect(
      app.db
        .query<{ provider: string }>(
          "SELECT provider FROM _externalAuths ORDER BY provider",
        )
        .map((r) => r.provider),
    ).toEqual(["github", "google"]);
  });
});

describe("provider response cap", () => {
  test("a body over the limit is cut at the limit", async () => {
    expect(await readText(new Response("x".repeat(100)), 10)).toBe(
      "x".repeat(10),
    );
  });

  test("an oversized JWKS fails the id_token check instead of being read whole", async () => {
    const big = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(`{"keys":[],"pad":"${"x".repeat(33 << 20)}"}`),
    });
    try {
      const b64 = (v: object) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const token = `${b64({ alg: "RS256", kid: "k1" })}.${b64({})}.sig`;
      await expect(
        validateTokenSignature(
          token,
          big.url.toString(),
          clock,
          AbortSignal.timeout(5000),
        ),
      ).rejects.toThrow(SyntaxError);
    } finally {
      await big.stop(true);
    }
  });
});
