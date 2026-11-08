import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { providers } from "../src/auth/oauth2/providers";
import {
  type Snapshot,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";
import {
  type MockProfile,
  type OAuth2Mock,
  startOAuth2Mock,
} from "./oauth2-mock";

let targets: Awaited<ReturnType<typeof startTargets>>;
let mock: OAuth2Mock;

const PASSWORD = "12345678";
const REDIRECT = "https://app.example/redirect";

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
  opts: { headers?: string[] } = {},
): Promise<[Snapshot, Snapshot]> {
  const pair = await both(fn, opts);
  expect(pair[0].status).toBe(status);
  expectSame(pair[0], pair[1]);
  return pair;
}

const providerConfig = (name: string, userInfoPath: string) => ({
  name,
  clientId: mock.clientId,
  clientSecret: mock.clientSecret,
  authURL: `${mock.url}/authorize`,
  tokenURL: `${mock.url}/token`,
  userInfoURL: `${mock.url}${userInfoPath}`,
});

const mockProviders = () => [
  providerConfig("google", "/userinfo"),
  providerConfig("github", "/github/user"),
  providerConfig("oidc", "/userinfo"),
];

function google(
  code: string,
  user: Record<string, unknown>,
  more: Partial<MockProfile> = {},
) {
  mock.set(code, { user, ...more });
}

// PB serializes `meta` from a Go map, so its key order is random; the id placeholders depend on the
// order, so both answers get the keys sorted.
async function sortedMeta(res: Response): Promise<Response> {
  const body = (await res.json()) as { meta?: Record<string, unknown> };
  if (body.meta)
    body.meta = Object.fromEntries(
      Object.entries(body.meta).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  return new Response(JSON.stringify(body), {
    status: res.status,
    headers: res.headers,
  });
}

const oauthRequest = (
  t: Target,
  collection: string,
  body: Record<string, unknown>,
  token: string | null = null,
) =>
  api(
    t,
    "POST",
    `/api/collections/${collection}/auth-with-oauth2`,
    body,
    token,
  ).then(sortedMeta);

async function oauth(
  collection: string,
  provider: string,
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  tokens?: Record<Target["name"], string>,
) {
  return same(
    (t) =>
      oauthRequest(
        t,
        collection,
        { provider, code, redirectURL: REDIRECT, ...extra },
        tokens ? tokens[t.name] : null,
      ),
    status,
  );
}

const records = (collection: string, filter: string) =>
  same(
    (t) =>
      api(
        t,
        "GET",
        `/api/collections/${collection}/records?filter=${encodeURIComponent(filter)}`,
      ),
    200,
  );

const externalAuths = (filter: string) => records("_externalAuths", filter);

async function passwordLogin(
  collection: string,
  email: string,
  status: number,
) {
  const tokens = {} as Record<Target["name"], string>;
  await same(async (t) => {
    const res = await api(
      t,
      "POST",
      `/api/collections/${collection}/auth-with-password`,
      { identity: email, password: PASSWORD },
      null,
    );
    if (res.ok)
      tokens[t.name] = ((await res.clone().json()) as { token: string }).token;
    return res;
  }, status);
  return tokens;
}

beforeAll(async () => {
  mock = startOAuth2Mock();
  targets = await startTargets();
  const authFields = [
    { name: "name", type: "text", max: 20 },
    { name: "username", type: "text" },
    {
      name: "avatar",
      type: "file",
      maxSelect: 1,
      mimeTypes: ["image/png"],
    },
  ];
  await same(
    (t) =>
      api(t, "POST", "/api/collections", {
        name: "oausers",
        type: "auth",
        createRule: "",
        fields: authFields,
        indexes: [
          "CREATE UNIQUE INDEX idx_oausers_username ON oausers (username) WHERE username != ''",
        ],
        oauth2: {
          enabled: true,
          providers: mockProviders(),
          mappedFields: {
            name: "name",
            username: "username",
            avatarURL: "avatar",
          },
        },
      }),
    200,
  );
  await same(
    (t) =>
      api(t, "POST", "/api/collections", {
        name: "oaurl",
        type: "auth",
        createRule: "",
        fields: [{ name: "pic", type: "text" }],
        oauth2: {
          enabled: true,
          providers: mockProviders(),
          mappedFields: { id: "pic", avatarURL: "pic" },
        },
      }),
    200,
  );
  await same(
    (t) =>
      api(t, "POST", "/api/collections", {
        name: "oaclosed",
        type: "auth",
        oauth2: { enabled: true, providers: mockProviders() },
      }),
    200,
  );
  await same(
    (t) =>
      api(t, "POST", "/api/collections", {
        name: "oamfa",
        type: "auth",
        createRule: "",
        mfa: { enabled: true },
        oauth2: { enabled: true, providers: mockProviders() },
      }),
    200,
  );
  await same(
    (t) =>
      api(t, "POST", "/api/collections", {
        name: "oaall",
        type: "auth",
        oauth2: {
          enabled: true,
          providers: Object.keys(providers).map((name) => ({
            name,
            clientId: "id",
            clientSecret: "secret",
          })),
        },
      }),
    200,
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
  await mock.stop();
});

// state, PKCE values and the auth URLs carrying them are random per call
function maskAuthMethods(body: unknown): unknown {
  const text = JSON.stringify(body)
    .replace(/"state":"[A-Za-z0-9]{30}"/g, '"state":"<state>"')
    .replace(/"codeVerifier":"[A-Za-z0-9]{43}"/g, '"codeVerifier":"<verifier>"')
    .replace(/"codeChallenge":"[\w-]{43}"/g, '"codeChallenge":"<challenge>"')
    .replace(/state=[A-Za-z0-9]{30}/g, "state=<state>")
    .replace(/code_challenge=[\w-]{43}/g, "code_challenge=<challenge>");
  return JSON.parse(text);
}

async function authMethods(collection: string): Promise<void> {
  const [pb, hb] = await both((t) =>
    api(
      t,
      "GET",
      `/api/collections/${collection}/auth-methods`,
      undefined,
      null,
    ),
  );
  expect(pb.status).toBe(200);
  expect(maskAuthMethods(hb.body)).toEqual(maskAuthMethods(pb.body));
  expect(hb.headers).toEqual(pb.headers);
}

describe("providers meta", () => {
  test("superuser", () =>
    same((t) => api(t, "GET", "/api/collections/meta/oauth2-providers"), 200));
  test("guest", () =>
    same(
      (t) =>
        api(
          t,
          "GET",
          "/api/collections/meta/oauth2-providers",
          undefined,
          null,
        ),
      401,
    ));
});

describe("auth-methods", () => {
  test("mock providers", () => authMethods("oausers"));
  test("every provider with its defaults", () => authMethods("oaall"));
  test("oauth2 disabled", () => authMethods("users"));
});

describe("auth-with-oauth2 validation", () => {
  test("empty body", () => oauth("oausers", "", "", 400));
  test("provider not configured", () => oauth("oausers", "facebook", "x", 400));
  test("unknown provider", () => oauth("oausers", "nope", "x", 400));
  test("missing code", () => oauth("oausers", "google", "", 400));
  test("too long provider", () => oauth("oausers", "x".repeat(101), "x", 400));
  test("non-string code", () => oauth("oausers", "google", 5 as never, 400));
  test("oauth2 disabled", () => oauth("users", "google", "x", 403));
  test("superusers", () => oauth("_superusers", "google", "x", 403));
  test("unknown collection", () => oauth("nope", "google", "x", 404));
});

describe("new user", () => {
  test("created with mapped fields, verified, linked; the loopback avatar is not downloaded", async () => {
    google("new-1", {
      sub: "g-new",
      name: "Gina",
      email: "gina@example.com",
      email_verified: true,
      picture: mock.avatarURL,
    });
    await oauth("oausers", "google", "new-1", 200);
    await records("oausers", "email='gina@example.com'");
    await externalAuths("providerId='g-new'");
  });

  test("second login reuses the external auth", async () => {
    await oauth("oausers", "google", "new-1", 200);
    await externalAuths("providerId='g-new'");
  });

  test("github username and verified primary email", async () => {
    mock.set("gh-1", {
      user: { id: 501, login: "octo", name: "Octo Cat", avatar_url: "" },
      emails: [
        { email: "octo-old@example.com", verified: true, primary: false },
        { email: "octo@example.com", verified: true, primary: true },
      ],
    });
    await oauth("oausers", "github", "gh-1", 200);
  });

  test("a taken username is not assigned", async () => {
    mock.set("gh-2", {
      user: { id: 502, login: "octo", name: "Other", avatar_url: "" },
      emails: [{ email: "octo2@example.com", verified: true, primary: true }],
    });
    await oauth("oausers", "github", "gh-2", 200);
  });

  test("oidc", async () => {
    google("oidc-1", {
      sub: "o-1",
      name: "Olga",
      preferred_username: "olga",
      email: "olga@example.com",
      email_verified: "true",
    });
    await oauth("oausers", "oidc", "oidc-1", 200);
  });

  test("createData is honored over the mapped fields", async () => {
    google("cd-1", {
      sub: "g-cd",
      name: "Mapped",
      email: "cd@example.com",
      email_verified: true,
    });
    await oauth("oausers", "google", "cd-1", 200, {
      createData: { name: "Chosen", username: "picked", emailVisibility: true },
    });
  });

  test("avatar URL into a text field and the id mapping", async () => {
    google("url-1", {
      sub: "g-url",
      email: "url@example.com",
      email_verified: true,
      picture: mock.avatarURL,
    });
    await oauth("oaurl", "google", "url-1", 200);
  });

  test("an unverified provider email is not linked", async () => {
    google("unv-1", {
      sub: "g-unv",
      email: "gina@example.com",
      email_verified: false,
    });
    // no email to link or create with
    await oauth("oausers", "google", "unv-1", 400);
    await externalAuths("providerId='g-unv'");
  });
});

describe("existing users", () => {
  test("a verified user with the provider email is linked, password kept", async () => {
    await same(
      (t) =>
        api(t, "POST", "/api/collections/oausers/records", {
          email: "vic@example.com",
          password: PASSWORD,
          passwordConfirm: PASSWORD,
          verified: true,
        }),
      200,
    );
    google("vic-1", {
      sub: "g-vic",
      email: "vic@example.com",
      email_verified: true,
    });
    await oauth("oausers", "google", "vic-1", 200);
    await passwordLogin("oausers", "vic@example.com", 200);
  });

  test("an unverified user is verified, its password reset and other links dropped", async () => {
    // a pre-created account: email from createData, linked to a github account without a verified email
    mock.set("pre-gh", {
      user: { id: 666, login: "mallory", name: "Mallory", avatar_url: "" },
      emails: [],
    });
    await oauth("oausers", "github", "pre-gh", 200, {
      createData: {
        email: "uma@example.com",
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      },
    });
    await records("oausers", "email='uma@example.com'");
    await passwordLogin("oausers", "uma@example.com", 200);

    google("uma-1", {
      sub: "g-uma",
      email: "uma@example.com",
      email_verified: true,
    });
    await oauth("oausers", "google", "uma-1", 200);
    await records("oausers", "email='uma@example.com'");
    await passwordLogin("oausers", "uma@example.com", 400);
    await externalAuths("providerId='666' || providerId='g-uma'");

    // the attacker's github account no longer reaches the record (and has no email to sign up with)
    await oauth("oausers", "github", "pre-gh", 400);
  });

  test("an unverified record that stays unverified keeps only the newest link", async () => {
    mock.set("pat-gh", {
      user: { id: 888, login: "pat", name: "Pat", avatar_url: "" },
      emails: [],
    });
    const tokens = {} as Record<Target["name"], string>;
    await same(async (t) => {
      const res = await oauthRequest(t, "oausers", {
        provider: "github",
        code: "pat-gh",
        createData: { email: "pat@example.com" },
      });
      tokens[t.name] = ((await res.clone().json()) as { token: string }).token;
      return res;
    }, 200);
    google("pat-g", {
      sub: "g-pat",
      email: "elsewhere@example.com",
      email_verified: true,
    });
    await oauth("oausers", "google", "pat-g", 200, {}, tokens);
    await records("oausers", "email='pat@example.com'");
    await externalAuths("providerId='888' || providerId='g-pat'");
  });

  test("a logged in user links another provider account", async () => {
    await same(
      (t) =>
        api(t, "POST", "/api/collections/oausers/records", {
          email: "lin@example.com",
          password: PASSWORD,
          passwordConfirm: PASSWORD,
          verified: true,
        }),
      200,
    );
    const tokens = await passwordLogin("oausers", "lin@example.com", 200);
    mock.set("lin-gh", {
      user: { id: 777, login: "linus", name: "Linus", avatar_url: "" },
      emails: [{ email: "other@example.com", verified: true, primary: true }],
    });
    await oauth("oausers", "github", "lin-gh", 200, {}, tokens);
    await externalAuths("providerId='777'");
    await records("oausers", "email='other@example.com'");
  });
});

describe("failures leave nothing behind", () => {
  test("provider token error", async () => {
    google(
      "bad-token",
      { sub: "g-bt", email: "bt@example.com", email_verified: true },
      { tokenError: true },
    );
    await oauth("oausers", "google", "bad-token", 400);
    await records("oausers", "email='bt@example.com'");
  });

  test("unknown code", () => oauth("oausers", "google", "never-issued", 400));

  test("provider user-info error", async () => {
    google(
      "bad-user",
      { sub: "g-bu", email: "bu@example.com", email_verified: true },
      { userError: true },
    );
    await oauth("oausers", "google", "bad-user", 400);
    await records("oausers", "email='bu@example.com'");
    await externalAuths("providerId='g-bu'");
  });

  test("a provider user without id rolls the created record back", async () => {
    google("no-id", { email: "noid@example.com", email_verified: true });
    await oauth("oausers", "google", "no-id", 400);
    await records("oausers", "email='noid@example.com'");
  });

  test("invalid createData", async () => {
    google("bad-cd", {
      sub: "g-bcd",
      email: "bcd@example.com",
      email_verified: true,
    });
    await oauth("oausers", "google", "bad-cd", 400, {
      createData: { name: "a name longer than twenty" },
    });
    await records("oausers", "email='bcd@example.com'");
    await externalAuths("providerId='g-bcd'");
  });

  test("create rule closed", async () => {
    google("closed-1", {
      sub: "g-cl",
      email: "cl@example.com",
      email_verified: true,
    });
    await oauth("oaclosed", "google", "closed-1", 403);
    await records("oaclosed", "email='cl@example.com'");
    await externalAuths("providerId='g-cl'");
  });
});

describe("MFA", () => {
  test("an OAuth2-only login asks for a second method, which then completes it", async () => {
    await same(
      (t) =>
        api(t, "POST", "/api/collections/oamfa/records", {
          email: "mfa@example.com",
          password: PASSWORD,
          passwordConfirm: PASSWORD,
          verified: true,
        }),
      200,
    );
    google("mfa-1", {
      sub: "g-mfa",
      email: "mfa@example.com",
      email_verified: true,
    });
    const mfaIds = {} as Record<Target["name"], string>;
    const [first] = await same(async (t) => {
      const res = await oauthRequest(t, "oamfa", {
        provider: "google",
        code: "mfa-1",
        redirectURL: REDIRECT,
      });
      mfaIds[t.name] = ((await res.clone().json()) as { mfaId: string }).mfaId;
      return res;
    }, 401);
    expect(first.body).toEqual({ mfaId: "<mfaId>" });
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/oamfa/auth-with-password",
          {
            identity: "mfa@example.com",
            password: PASSWORD,
            mfaId: mfaIds[t.name],
          },
          null,
        ),
      200,
    );
  });
});

describe("PKCE", () => {
  async function authorize(
    code: string,
  ): Promise<Record<Target["name"], string>> {
    const verifiers = {} as Record<Target["name"], string>;
    for (const t of [targets.pb, targets.hb]) {
      const res = await api(
        t,
        "GET",
        "/api/collections/oausers/auth-methods",
        undefined,
        null,
      );
      const body = (await res.json()) as {
        oauth2: {
          providers: { name: string; authURL: string; codeVerifier: string }[];
        };
      };
      const google = body.oauth2.providers.find((p) => p.name === "google")!;
      const back = await fetch(
        `${google.authURL}${encodeURIComponent(REDIRECT)}&code=${code}`,
        { redirect: "manual" },
      );
      expect(
        new URL(back.headers.get("location")!).searchParams.get("code"),
      ).toBe(code);
      verifiers[t.name] = google.codeVerifier;
    }
    return verifiers;
  }

  test("the code verifier from auth-methods is sent to the provider", async () => {
    google("pk-1", {
      sub: "g-pk1",
      email: "pk1@example.com",
      email_verified: true,
    });
    const verifiers = await authorize("pk-1");
    await same(
      (t) =>
        oauthRequest(t, "oausers", {
          provider: "google",
          code: "pk-1",
          codeVerifier: verifiers[t.name],
          redirectURL: REDIRECT,
        }),
      200,
    );
  });

  test("a wrong code verifier fails at the provider", async () => {
    google("pk-2", {
      sub: "g-pk2",
      email: "pk2@example.com",
      email_verified: true,
    });
    await authorize("pk-2");
    await oauth("oausers", "google", "pk-2", 400, {
      codeVerifier: "x".repeat(43),
    });
    await records("oausers", "email='pk2@example.com'");
  });
});

describe("oauth2-redirect", () => {
  const redirect = (method: string, query: string, form?: string) =>
    same(
      (t) =>
        fetch(`${t.url}/api/oauth2-redirect${query}`, {
          method,
          redirect: "manual",
          headers: form
            ? { "content-type": "application/x-www-form-urlencoded" }
            : {},
          body: form,
        }),
      method === "GET" ? 307 : 303,
      { headers: ["location"] },
    );

  test("missing state", () => redirect("GET", ""));
  test("unknown client", () => redirect("GET", "?state=abc&code=123"));
  test("provider error", () => redirect("GET", "?state=abc&error=denied"));
  test("form post", () => redirect("POST", "", "state=abc&code=123"));
});
