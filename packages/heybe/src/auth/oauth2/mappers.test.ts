import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { App } from "../../app";
import { type AuthUser, type OAuth2Token, initProvider } from "./flow";
import { makeApple, mappers } from "./mappers";
import { providers } from "./providers";

const clock = new Date("2026-01-01T00:00:00Z");
const ctx = () => ({
  app: { now: () => clock } as App,
  signal: new AbortController().signal,
});
const token = (raw: Record<string, unknown> = {}): OAuth2Token => ({
  accessToken: "at",
  tokenType: "Bearer",
  refreshToken: "rt",
  expiry: new Date("2026-01-01T01:00:00Z"),
  raw,
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}
type Route = { status?: number; body: unknown };
let calls: Call[] = [];
const json = (route: Route) =>
  new Response(
    typeof route.body === "string" ? route.body : JSON.stringify(route.body),
    { status: route.status ?? 200 },
  );

// serves `routes` by URL and fails on any other request, so no test reaches the network
function stubFetch(routes: Record<string, Route>) {
  calls = [];
  spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return json(route);
  }) as typeof fetch);
}
afterEach(() => (fetch as { mockRestore?: () => void }).mockRestore?.());

const provider = (name: string, extra?: object, userInfoURL?: string) =>
  initProvider({
    name,
    clientId: "cid",
    clientSecret: "secret",
    ...(userInfoURL ? { userInfoURL } : {}),
    ...(extra ? { extra } : {}),
  })!;

const run = (
  name: string,
  raw: unknown,
  opts: {
    extra?: object;
    userInfoURL?: string;
    token?: OAuth2Token;
    more?: Record<string, Route>;
  } = {},
) => {
  const p = provider(name, opts.extra, opts.userInfoURL);
  stubFetch({ [p.userInfoURL]: { body: raw }, ...opts.more });
  return mappers[name]!(p, opts.token ?? token(), ctx());
};

const pick = (u: AuthUser) => ({
  id: u.id,
  name: u.name,
  username: u.username,
  email: u.email,
  avatarURL: u.avatarURL,
});

const user = (
  id: string,
  name: string,
  username: string,
  email: string,
  avatarURL: string,
) => ({ id, name, username, email, avatarURL });

describe("every PB provider has a mapper", () => {
  test("covers the provider table", () => {
    const own = ["github", "google", "oidc", "oidc2", "oidc3"];
    expect(Object.keys(mappers).sort()).toEqual(
      Object.keys(providers)
        .filter((n) => !own.includes(n))
        .sort(),
    );
  });
});

// Raw users follow the documented responses PB's mappers read (PB has no per-provider fixtures).
const table: [string, unknown, ReturnType<typeof user>][] = [
  [
    "box",
    {
      id: "b1",
      name: "Bo",
      login: "bo@example.com",
      avatar_url: "https://a/b.png",
      status: "active",
    },
    user("b1", "Bo", "", "bo@example.com", "https://a/b.png"),
  ],
  [
    "discord",
    {
      id: "d1",
      global_name: "Dee",
      username: "dee",
      discriminator: "0",
      avatar: "abc",
      email: "dee@example.com",
      verified: true,
    },
    user(
      "d1",
      "Dee",
      "dee",
      "dee@example.com",
      "https://cdn.discordapp.com/avatars/d1/abc.png",
    ),
  ],
  [
    "discord",
    {
      id: "d2",
      global_name: null,
      username: "old",
      discriminator: "1234",
      avatar: "",
      email: "old@example.com",
      verified: false,
    },
    user("d2", "old#1234", "old", "", ""),
  ],
  [
    "discord",
    { id: "d3", username: "new", discriminator: "0" },
    user("d3", "new", "new", "", ""),
  ],
  [
    "facebook",
    {
      id: "f1",
      name: "Fay",
      email: "fay@example.com",
      picture: { data: { url: "https://a/f.png" } },
    },
    user("f1", "Fay", "", "fay@example.com", "https://a/f.png"),
  ],
  ["facebook", { id: "f2", name: "NoMail" }, user("f2", "NoMail", "", "", "")],
  [
    "gitlab",
    {
      id: 7,
      name: "Gil",
      username: "gil",
      email: "gil@example.com",
      avatar_url: "https://a/g.png",
      confirmed_at: "2024-01-02T03:04:05.678Z",
    },
    user("7", "Gil", "gil", "gil@example.com", "https://a/g.png"),
  ],
  [
    "gitlab",
    {
      id: 8,
      name: "Unconfirmed",
      username: "unc",
      email: "unc@example.com",
      confirmed_at: "",
    },
    user("8", "Unconfirmed", "unc", "", ""),
  ],
  [
    "gitlab",
    {
      id: 9,
      name: "Bad",
      username: "bad",
      email: "bad@example.com",
      confirmed_at: "yesterday",
    },
    user("9", "Bad", "bad", "", ""),
  ],
  ...[
    "2024-01-02T03:04:05Z",
    "2024-01-02T03:04:05.123456Z",
    "2024-01-02T03:04:05+02:00",
    "0001-01-01T00:00:01Z",
  ].map((confirmed_at, i): (typeof table)[number] => [
    "gitlab",
    {
      id: 20 + i,
      name: "G",
      username: "g",
      email: "g@example.com",
      confirmed_at,
    },
    user(String(20 + i), "G", "g", "g@example.com", ""),
  ]),
  ...[
    "2024-02-30T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:60:00Z",
    "2024-01-01T00:00:60Z",
    "2024-01-01T00:00:00+24:00",
    "0001-01-01T00:00:00Z",
    "0001-01-01T01:00:00+01:00",
    "2024-01-01 00:00:00Z",
  ].map((confirmed_at, i): (typeof table)[number] => [
    "gitlab",
    {
      id: 30 + i,
      name: "G",
      username: "g",
      email: "g@example.com",
      confirmed_at,
    },
    user(String(30 + i), "G", "g", "", ""),
  ]),
  [
    "instagram2",
    {
      id: "i0",
      user_id: "i1",
      name: "Ina",
      username: "ina",
      profile_picture_url: "https://a/i.png",
    },
    user("i1", "Ina", "ina", "", "https://a/i.png"),
  ],
  [
    "kakao",
    {
      id: 99,
      properties: { nickname: "Kay", profile_image: "https://a/k.png" },
      kakao_account: {
        email: "kay@example.com",
        is_email_verified: true,
        is_email_valid: true,
      },
    },
    user("99", "", "Kay", "kay@example.com", "https://a/k.png"),
  ],
  [
    "kakao",
    {
      id: 98,
      properties: { nickname: "Kay" },
      kakao_account: {
        email: "kay@example.com",
        is_email_verified: true,
        is_email_valid: false,
      },
    },
    user("98", "", "Kay", "", ""),
  ],
  [
    "kakao",
    {
      id: 97,
      kakao_account: {
        email: "kay@example.com",
        is_email_verified: false,
        is_email_valid: true,
      },
    },
    user("97", "", "", "", ""),
  ],
  [
    "lark",
    {
      code: 0,
      data: {
        union_id: "on_1",
        name: "Lia",
        avatar_url: "https://a/l.png",
        email: "lia@example.com",
      },
    },
    user("on_1", "Lia", "", "", "https://a/l.png"),
  ],
  [
    "linear",
    {
      data: {
        viewer: {
          id: "l1",
          displayName: "lin",
          name: "Lin",
          email: "lin@example.com",
          avatarUrl: "https://a/n.png",
          active: true,
        },
      },
    },
    user("l1", "Lin", "lin", "lin@example.com", "https://a/n.png"),
  ],
  [
    "livechat",
    {
      account_id: "c1",
      name: "Chat",
      email: "chat@example.com",
      email_verified: true,
      avatar_url: "https://a/c.png",
    },
    user("c1", "Chat", "", "chat@example.com", "https://a/c.png"),
  ],
  [
    "livechat",
    {
      account_id: "c2",
      name: "Chat",
      email: "chat@example.com",
      email_verified: false,
    },
    user("c2", "Chat", "", "", ""),
  ],
  [
    "mailcow",
    {
      id: "m1",
      username: "max@mail.example.com",
      email: "max@mail.example.com",
      full_name: "Max",
      active: 1,
    },
    user("m1", "Max", "max", "max@mail.example.com", ""),
  ],
  [
    "mailcow",
    {
      id: "m2",
      username: "plain",
      email: "p@mail.example.com",
      full_name: "P",
      active: 1,
    },
    user("m2", "P", "plain", "p@mail.example.com", ""),
  ],
  [
    "microsoft",
    {
      id: "ms1",
      displayName: "Mia",
      mail: "mia@example.com",
      userPrincipalName: "mia@x.onmicrosoft.com",
    },
    user("ms1", "Mia", "", "mia@example.com", ""),
  ],
  [
    "microsoft",
    { id: "ms2", displayName: "Mia", mail: null },
    user("ms2", "Mia", "", "", ""),
  ],
  [
    "monday",
    {
      data: {
        me: {
          id: "mo1",
          enabled: true,
          name: "Mon",
          email: "mon@example.com",
          is_verified: true,
          photo_small: "https://a/m.png",
        },
      },
    },
    user("mo1", "Mon", "", "mon@example.com", "https://a/m.png"),
  ],
  [
    "monday",
    {
      data: {
        me: {
          id: "mo2",
          enabled: true,
          name: "Mon",
          email: "mon@example.com",
          is_verified: false,
        },
      },
    },
    user("mo2", "Mon", "", "", ""),
  ],
  [
    "notion",
    {
      object: "user",
      id: "bot1",
      name: "Bot",
      type: "bot",
      bot: {
        owner: {
          type: "user",
          user: {
            id: "n1",
            name: "Noa",
            avatar_url: "https://a/n.png",
            person: { email: "noa@example.com" },
          },
        },
        workspace_name: "W",
      },
    },
    user("n1", "Noa", "", "noa@example.com", "https://a/n.png"),
  ],
  [
    "patreon",
    {
      data: {
        id: "p1",
        attributes: {
          email: "pat@example.com",
          full_name: "Pat",
          vanity: "pat",
          image_url: "https://a/p.png",
          is_email_verified: true,
        },
      },
    },
    user("p1", "Pat", "pat", "pat@example.com", "https://a/p.png"),
  ],
  [
    "patreon",
    {
      data: {
        id: "p2",
        attributes: {
          email: "pat@example.com",
          full_name: "Pat",
          vanity: null,
          is_email_verified: false,
        },
      },
    },
    user("p2", "Pat", "", "", ""),
  ],
  [
    "planningcenter",
    {
      data: {
        id: "pc1",
        attributes: {
          status: "active",
          name: "Pia",
          avatar: "https://a/pc.png",
          email: "pia@example.com",
        },
      },
    },
    user("pc1", "Pia", "", "", "https://a/pc.png"),
  ],
  [
    "spotify",
    {
      id: "s1",
      display_name: "Spo",
      email: "spo@example.com",
      images: [{ url: "https://a/s1.png" }, { url: "https://a/s2.png" }],
    },
    user("s1", "Spo", "", "", "https://a/s1.png"),
  ],
  [
    "spotify",
    { id: "s2", display_name: "Spo", images: [] },
    user("s2", "Spo", "", "", ""),
  ],
  [
    "strava",
    {
      id: 5,
      firstname: "Stra",
      lastname: "Va",
      username: "sv",
      profile: "https://a/sv.png",
    },
    user("5", "Stra Va", "sv", "", "https://a/sv.png"),
  ],
  ["strava", { id: 0, firstname: "Only" }, user("", "Only ", "", "", "")],
  [
    "trakt",
    {
      user: {
        username: "tra",
        name: "Tra",
        ids: { slug: "tra", uuid: "u-1" },
        images: { avatar: { full: "https://a/t.png" } },
      },
    },
    user("u-1", "Tra", "tra", "", "https://a/t.png"),
  ],
  [
    "twitch",
    {
      data: [
        {
          id: "t1",
          login: "twi",
          display_name: "Twi",
          email: "twi@example.com",
          profile_image_url: "https://a/tw.png",
        },
      ],
    },
    user("t1", "Twi", "twi", "twi@example.com", "https://a/tw.png"),
  ],
  [
    "twitter",
    {
      data: {
        id: "x1",
        name: "Xia",
        username: "xia",
        confirmed_email: "xia@example.com",
        profile_image_url: "https://a/x.png",
      },
    },
    user("x1", "Xia", "xia", "xia@example.com", "https://a/x.png"),
  ],
  [
    "twitter",
    { data: { id: "x2", name: "Xia", username: "xia" } },
    user("x2", "Xia", "xia", "", ""),
  ],
  [
    "vk",
    {
      response: [
        {
          id: 11,
          first_name: "Vik",
          last_name: "Tor",
          screen_name: "vik",
          photo_max: "https://a/v.png",
        },
      ],
    },
    user("11", "Vik Tor", "vik", "", "https://a/v.png"),
  ],
  [
    "vk",
    { response: [{ id: 12, first_name: "Solo", last_name: "" }] },
    user("12", "Solo", "", "", ""),
  ],
  [
    "wakatime",
    {
      data: {
        id: "w1",
        display_name: "Wak",
        username: "wak",
        email: "wak@example.com",
        is_email_confirmed: true,
        photo: "https://a/w.png",
        photo_public: true,
      },
    },
    user("w1", "Wak", "wak", "wak@example.com", "https://a/w.png"),
  ],
  [
    "wakatime",
    {
      data: {
        id: "w2",
        display_name: "Wak",
        username: "wak",
        email: "wak@example.com",
        is_email_confirmed: false,
        photo: "https://a/w.png",
        photo_public: false,
      },
    },
    user("w2", "Wak", "wak", "", ""),
  ],
  [
    "yandex",
    {
      id: "y1",
      real_name: "Yan",
      login: "yan",
      default_email: "yan@example.com",
      is_avatar_empty: false,
      default_avatar_id: "av1",
    },
    user(
      "y1",
      "Yan",
      "yan",
      "yan@example.com",
      "https://avatars.yandex.net/get-yapic/av1/islands-200",
    ),
  ],
  [
    "yandex",
    {
      id: "y2",
      real_name: "Yan",
      login: "yan",
      default_email: "yan@example.com",
      is_avatar_empty: true,
      default_avatar_id: "av1",
    },
    user("y2", "Yan", "yan", "yan@example.com", ""),
  ],
];

describe("raw user to AuthUser", () => {
  test.each(table)("%s", async (name, raw, expected) => {
    const result = await run(name, raw);
    expect(pick(result)).toEqual(expected);
    expect(result.rawUser).toEqual(raw as Record<string, unknown>);
    expect(result.accessToken).toBe("at");
    expect(result.refreshToken).toBe("rt");
    expect(result.expiry).toBe("2026-01-01 01:00:00.000Z");
  });
});

describe("account state", () => {
  test.each([
    ["box", { id: "b", status: "inactive" }],
    ["linear", { data: { viewer: { id: "l", active: false } } }],
    ["mailcow", { id: "m", active: 0 }],
    ["monday", { data: { me: { id: "m", enabled: false } } }],
    [
      "planningcenter",
      { data: { id: "p", attributes: { status: "inactive" } } },
    ],
  ])("%s rejects an inactive account", async (name, raw) => {
    await expect(run(name, raw)).rejects.toThrow(
      /not (active|enabled)|inactive/,
    );
  });

  test.each([
    ["twitch", { data: [] }, "failed to fetch AuthUser data"],
    ["vk", { response: [] }, "missing response entry"],
  ])("%s rejects an empty list", async (name, raw, message) => {
    await expect(run(name, raw)).rejects.toThrow(message);
  });

  test.each([
    ["discord", { id: 5 }],
    ["gitlab", { id: "7" }],
    ["kakao", { id: 1, kakao_account: "x" }],
    ["spotify", { id: "s", images: {} }],
    ["strava", { id: 1.5 }],
  ])("%s rejects a value of the wrong type", async (name, raw) => {
    await expect(run(name, raw)).rejects.toThrow();
  });
});

describe("user info request", () => {
  test("a failing status is an error", async () => {
    const p = provider("box");
    stubFetch({ [p.userInfoURL]: { status: 401, body: "no" } });
    await expect(mappers.box!(p, token(), ctx())).rejects.toThrow(
      /failed to fetch OAuth2 user profile .* \(401\)/,
    );
  });

  test("sends the bearer token to the overridden URL", async () => {
    await run(
      "box",
      { id: "b", status: "active" },
      { userInfoURL: "https://box.test/me" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://box.test/me");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer at");
  });

  test("notion sends its API version", async () => {
    await run("notion", {});
    expect(calls[0]!.headers.get("notion-version")).toBe("2022-06-28");
  });

  test("trakt sends the API key and version", async () => {
    await run("trakt", {});
    const h = calls[0]!.headers;
    expect(h.get("trakt-api-key")).toBe("cid");
    expect(h.get("trakt-api-version")).toBe("2");
    expect(h.get("content-type")).toBe("application/json");
  });

  test("twitch sends the client id", async () => {
    await run("twitch", { data: [{ id: "t" }] });
    expect(calls[0]!.headers.get("client-id")).toBe("cid");
  });

  test.each([
    ["linear", { data: { viewer: { active: true } } }, "viewer"],
    ["monday", { data: { me: { enabled: true } } }, "me"],
  ])("%s posts its GraphQL query", async (name, raw, field) => {
    await run(name, raw);
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(call!.body).query).toContain(field);
  });
});

describe("instagram permissions", () => {
  const raw = { user_id: "i1" };

  test("come from the token when the profile has none", async () => {
    const result = await run("instagram2", raw, {
      token: token({ permissions: "instagram_business_basic" }),
    });
    expect(result.rawUser).toEqual({
      user_id: "i1",
      permissions: "instagram_business_basic",
    });
  });

  test("the profile's own value wins", async () => {
    const result = await run(
      "instagram2",
      { ...raw, permissions: "profile" },
      { token: token({ permissions: "token" }) },
    );
    expect(result.rawUser.permissions).toBe("profile");
  });
});

describe("vk email", () => {
  test("comes from the token response", async () => {
    const result = await run(
      "vk",
      { response: [{ id: 1, first_name: "A" }] },
      { token: token({ email: "vk@example.com" }) },
    );
    expect(result.email).toBe("vk@example.com");
  });
});

describe("bitbucket", () => {
  const profile = {
    uuid: "{u-1}",
    username: "bit",
    display_name: "Bit",
    account_status: "active",
    links: { avatar: { href: "https://a/bb.png" } },
  };
  const emailsURL = `${providers.bitbucket!.userInfoURL}/emails`;
  const withEmails = (values: unknown[], status = 200) => ({
    more: { [emailsURL]: { status, body: { values } } },
  });

  test("uses the confirmed primary email", async () => {
    const result = await run(
      "bitbucket",
      profile,
      withEmails([
        { email: "other@example.com", is_primary: false, is_confirmed: true },
        { email: "new@example.com", is_primary: true, is_confirmed: false },
        { email: "bit@example.com", is_primary: true, is_confirmed: true },
      ]),
    );
    expect(pick(result)).toEqual(
      user("{u-1}", "Bit", "bit", "bit@example.com", "https://a/bb.png"),
    );
    expect(calls[1]!.headers.get("authorization")).toBe("Bearer at");
  });

  test("no email when none is confirmed and primary", async () => {
    const result = await run(
      "bitbucket",
      profile,
      withEmails([
        { email: "a@example.com", is_primary: true, is_confirmed: false },
      ]),
    );
    expect(result.email).toBe("");
  });

  test("an email request failure keeps the user without email", async () => {
    const result = await run("bitbucket", profile, withEmails([], 403));
    expect(result.id).toBe("{u-1}");
    expect(result.email).toBe("");
  });

  test("an inactive user is rejected before the email request", async () => {
    await expect(
      run("bitbucket", { ...profile, account_status: "inactive" }),
    ).rejects.toThrow("the Bitbucket user is not active");
    expect(calls).toHaveLength(1);
  });
});

describe("gitea", () => {
  const profile = {
    id: 3,
    full_name: "Gia",
    login: "gia",
    avatar_url: "https://a/gi.png",
    active: true,
  };
  const userInfoURL = "https://gitea.test/api/v1/user";
  const opts = (more: Record<string, Route>) => ({ userInfoURL, more });
  const emailsURL = `${userInfoURL}/emails`;

  test("uses the verified primary email", async () => {
    const result = await run(
      "gitea",
      profile,
      opts({
        [emailsURL]: {
          body: [
            { email: "a@example.com", verified: false, primary: true },
            { email: "b@example.com", verified: true, primary: false },
            { email: "gia@example.com", verified: true, primary: true },
          ],
        },
      }),
    );
    expect(pick(result)).toEqual(
      user("3", "Gia", "gia", "gia@example.com", "https://a/gi.png"),
    );
  });

  test.each([401, 403, 404])(
    "status %i leaves the email empty",
    async (status) => {
      const result = await run(
        "gitea",
        profile,
        opts({ [emailsURL]: { status, body: "" } }),
      );
      expect(result.email).toBe("");
    },
  );

  test("another error status fails", async () => {
    await expect(
      run(
        "gitea",
        profile,
        opts({ [emailsURL]: { status: 500, body: "boom" } }),
      ),
    ).rejects.toThrow();
  });

  test("an inactive user is rejected before the email request", async () => {
    await expect(
      run("gitea", { ...profile, active: false }, { userInfoURL }),
    ).rejects.toThrow("user account is not active");
    expect(calls).toHaveLength(1);
  });
});

describe("gitee", () => {
  const profile = {
    id: 4,
    login: "gee",
    name: "Gee",
    avatar_url: "https://a/ge.png",
  };
  const emailsURL = "https://gitee.com/api/v5/emails";

  test("a valid profile email needs no second request", async () => {
    const result = await run("gitee", { ...profile, email: "gee@example.com" });
    expect(pick(result)).toEqual(
      user("4", "Gee", "gee", "gee@example.com", "https://a/ge.png"),
    );
    expect(calls).toHaveLength(1);
  });

  test("an invalid profile email falls back to the confirmed primary one", async () => {
    const result = await run(
      "gitee",
      { ...profile, email: "not-an-email" },
      {
        more: {
          [emailsURL]: {
            body: [
              { email: "a@example.com", state: "pending", scope: ["primary"] },
              { email: "b@example.com", state: "confirmed", scope: ["commit"] },
              { email: "bad", state: "confirmed", scope: ["primary"] },
              {
                email: "gee@example.com",
                state: "confirmed",
                scope: ["commit", "primary"],
              },
            ],
          },
        },
      },
    );
    expect(result.email).toBe("gee@example.com");
  });

  test.each([
    ["status 404", { status: 404, body: "" }],
    ["status 500", { status: 500, body: "boom" }],
    ["invalid JSON", { body: "not json" }],
    [
      "no primary",
      { body: [{ email: "a@example.com", state: "confirmed", scope: [] }] },
    ],
  ])("%s leaves the email empty", async (_, route) => {
    const result = await run("gitee", profile, {
      more: { [emailsURL]: route },
    });
    expect(result.id).toBe("4");
    expect(result.email).toBe("");
  });
});

describe("microsoft idTokenEmailClaim", () => {
  const unsigned = (claims: object) =>
    `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
  const iat = clock.getTime() / 1000;
  const claims = {
    iat,
    exp: iat + 600,
    email: "claim@example.com",
    verified_primary_email: "vpe@example.com",
    xms_edov: true,
  };
  const profile = { id: "ms", displayName: "Mia", mail: "graph@example.com" };
  const withClaims = (c: object) => token({ id_token: unsigned(c) });
  const email = async (claim: unknown, t: OAuth2Token) =>
    (
      await run("microsoft", profile, {
        extra: { idTokenEmailClaim: claim },
        token: t,
      })
    ).email;

  test("default is the Graph mail", async () => {
    expect(await email(undefined, withClaims(claims))).toBe(
      "graph@example.com",
    );
    expect(await email("unknown", withClaims(claims))).toBe(
      "graph@example.com",
    );
  });

  test.each([
    ["email", claims, "claim@example.com"],
    ["verified_primary_email", claims, "vpe@example.com"],
    ["email_and_xms_edov", claims, "claim@example.com"],
    ["email_and_xms_edov", { ...claims, xms_edov: false }, ""],
    ["email_and_xms_edov", { ...claims, xms_edov: "1" }, "claim@example.com"],
    ["any_verified", claims, "vpe@example.com"],
    [
      "any_verified",
      { ...claims, verified_primary_email: undefined },
      "claim@example.com",
    ],
    [
      "any_verified",
      { ...claims, verified_primary_email: undefined, xms_edov: false },
      "",
    ],
    ["verified_primary_email", { ...claims, verified_primary_email: 5 }, ""],
    ["email", { ...claims, exp: iat - 3600 }, ""],
    ["email", { ...claims, iat: iat + 3600 }, ""],
  ])("%s with %j", async (claim, c, expected) => {
    expect(await email(claim, withClaims(c))).toBe(expected);
  });

  test("a missing or malformed id_token gives no email", async () => {
    expect(await email("email", token())).toBe("");
    expect(await email("email", token({ id_token: "garbage" }))).toBe("");
  });

  test("the claim adds the openid scope", () => {
    expect(provider("microsoft").scopes).toEqual(["User.Read"]);
    expect(
      provider("microsoft", { idTokenEmailClaim: "email" }).scopes,
    ).toEqual(["User.Read", "openid"]);
    expect(provider("microsoft", { idTokenEmailClaim: "" }).scopes).toEqual([
      "User.Read",
    ]);
    expect(
      provider("github", { idTokenEmailClaim: "email" }).scopes,
    ).not.toContain("openid");
  });
});

describe("apple id_token", () => {
  const jwksURL = "https://jwks.test/keys";
  const apple = makeApple(jwksURL);
  let keys: CryptoKeyPair;
  let jwks: object;
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
    jwks = {
      keys: [{ kty: "RSA", kid: "k1", alg: "RS256", n: jwk.n, e: jwk.e }],
    };
  });

  const b64 = (v: object) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  async function idToken(claims: object, key = () => keys.privateKey) {
    const input = `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}`;
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key(),
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  }
  const iat = clock.getTime() / 1000;
  const claims = {
    iss: "https://appleid.apple.com",
    aud: "cid",
    sub: "a1",
    email: "ann@privaterelay.appleid.com",
    email_verified: "true",
    iat,
    exp: iat + 600,
  };
  const login = async (t: unknown) => {
    stubFetch({ [jwksURL]: { body: jwks } });
    return apple(provider("apple"), token({ id_token: t }), ctx());
  };

  test("a signed token is the user, email_verified may be a string", async () => {
    const result = await login(await idToken(claims));
    expect(pick(result)).toEqual(
      user("a1", "", "", "ann@privaterelay.appleid.com", ""),
    );
    expect(result.rawUser).toEqual(claims);
  });

  test.each([
    ["false", { email_verified: "false" }],
    ["boolean false", { email_verified: false }],
    ["missing", { email_verified: undefined }],
  ])("email_verified %s drops the email", async (_, patch) => {
    const result = await login(await idToken({ ...claims, ...patch }));
    expect(result.id).toBe("a1");
    expect(result.email).toBe("");
  });

  test("boolean true keeps the email", async () => {
    const result = await login(
      await idToken({ ...claims, email_verified: true }),
    );
    expect(result.email).toBe("ann@privaterelay.appleid.com");
  });

  test.each([
    ["no exp", { exp: undefined }],
    ["expired", { exp: iat - 3600 }],
    ["another issuer", { iss: "https://evil.example" }],
    ["another audience", { aud: "other" }],
    ["issued in the future", { iat: iat + 3600 }],
  ])("rejects %s", async (_, patch) => {
    await expect(
      login(await idToken({ ...claims, ...patch })),
    ).rejects.toThrow();
  });

  test("rejects a missing id_token", async () => {
    await expect(login(undefined)).rejects.toThrow("empty id_token");
  });

  test("rejects a token signed by another key", async () => {
    const other = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      false,
      ["sign"],
    )) as CryptoKeyPair;
    await expect(
      login(await idToken(claims, () => other.privateKey)),
    ).rejects.toThrow("token signature is invalid");
  });

  test("the registered mapper verifies against Apple's keys", async () => {
    const p = provider("apple");
    stubFetch({ "https://appleid.apple.com/auth/keys": { body: jwks } });
    const result = await mappers.apple!(
      p,
      token({ id_token: await idToken(claims) }),
      ctx(),
    );
    expect(result.id).toBe("a1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://appleid.apple.com/auth/keys",
    ]);
  });
});
