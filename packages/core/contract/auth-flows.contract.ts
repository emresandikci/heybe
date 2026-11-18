import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";
import { type CapturedMail, type SmtpCapture, startSmtpCapture } from "./smtp";

let targets: Awaited<ReturnType<typeof startTargets>>;
let mail: { pocketbase: SmtpCapture; heybe: SmtpCapture };

const PASSWORD = "12345678";
const users = "/api/collections/users";

beforeAll(async () => {
  mail = {
    pocketbase: await startSmtpCapture(),
    heybe: await startSmtpCapture(),
  };
  targets = await startTargets();
  await both((t) =>
    api(t, "PATCH", "/api/settings", {
      meta: {
        appName: "Acme",
        appURL: "https://app.example",
        senderName: "Acme Support",
        senderAddress: "support@example.com",
      },
      smtp: {
        enabled: true,
        host: "127.0.0.1",
        port: mail[t.name].port,
        tls: false,
        username: "",
        password: "",
      },
    }),
  );
  await both((t) =>
    api(t, "POST", "/api/collections", {
      name: "members",
      type: "auth",
      passwordAuth: { enabled: false },
    }),
  );
  await both((t) =>
    api(t, "POST", "/api/collections", { name: "posts", type: "base" }),
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
  await Promise.all([mail.pocketbase.stop(), mail.heybe.stop()]);
});

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
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });

const perTarget = <T>(fn: (t: Target) => Promise<T>) =>
  Promise.all([fn(targets.pb), fn(targets.hb)]);

async function same(
  fn: (t: Target) => Promise<Response>,
  status: number,
): Promise<void> {
  const [pb, hb] = await both(fn);
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
}

const guest = (path: string, body: unknown, status: number) =>
  same((t) => api(t, "POST", path, body, null), status);

async function createUser(
  email: string,
  extra: Record<string, unknown> = {},
  collection = "users",
): Promise<Record<Target["name"], string>> {
  const [pb, hb] = await perTarget(async (t) => {
    const res = await api(t, "POST", `/api/collections/${collection}/records`, {
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      ...extra,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  });
  return { pocketbase: pb, heybe: hb };
}

async function login(
  t: Target,
  identity: string,
  password = PASSWORD,
): Promise<string> {
  const res = await api(
    t,
    "POST",
    `${users}/auth-with-password`,
    { identity, password },
    null,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

const loginBoth = async (identity: string, password = PASSWORD) => {
  const [pb, hb] = await perTarget((t) => login(t, identity, password));
  return { pocketbase: pb, heybe: hb };
};

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

function normalized(m: CapturedMail) {
  const clean = (s: string) =>
    s.replace(new RegExp(JWT, "g"), "<token>").replace(/\r\n/g, "\n");
  return {
    from: m.from,
    recipients: m.recipients,
    to: m.to,
    subject: clean(m.subject),
    html: clean(m.html),
    text: clean(m.text),
  };
}

// Waits for the mail to `address` on both captures, compares them and returns each target's token.
async function mailTokens(
  address: string,
): Promise<Record<Target["name"], string>> {
  const [pb, hb] = await Promise.all([
    mail.pocketbase.waitFor(address),
    mail.heybe.waitFor(address),
  ]);
  expect(normalized(hb)).toEqual(normalized(pb));
  return {
    pocketbase: JWT.exec(pb.html)![0],
    heybe: JWT.exec(hb.html)![0],
  };
}

const sentTo = (address: string) =>
  [mail.pocketbase, mail.heybe].map(
    (m) => m.messages().filter((x) => x.recipients.includes(address)).length,
  );

const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());

const getRecord = (ids: Record<Target["name"], string>) =>
  same((t) => api(t, "GET", `${users}/records/${ids[t.name]}`), 200);

describe("request-verification", () => {
  test("known, unknown and already verified emails all get 204 and only the unverified one a mail", async () => {
    await createUser("v-known@example.com");
    await createUser("v-done@example.com", { verified: true });
    await guest(
      `${users}/request-verification`,
      { email: "v-nobody@example.com" },
      204,
    );
    await guest(
      `${users}/request-verification`,
      { email: "v-done@example.com" },
      204,
    );
    await guest(
      `${users}/request-verification`,
      { email: "v-known@example.com" },
      204,
    );
    const tokens = await mailTokens("v-known@example.com");
    expect(claims(tokens.heybe)).toMatchObject({
      type: "verification",
      email: "v-known@example.com",
    });
    expect(Object.keys(claims(tokens.heybe)).sort()).toEqual(
      Object.keys(claims(tokens.pocketbase)).sort(),
    );
    expect(sentTo("v-nobody@example.com")).toEqual([0, 0]);
    expect(sentTo("v-done@example.com")).toEqual([0, 0]);
  });

  test("validation and collection errors", async () => {
    const path = `${users}/request-verification`;
    await guest(path, {}, 400);
    await guest(path, { email: "nope" }, 400);
    await guest(path, { email: `${"a".repeat(250)}@example.com` }, 400);
    await guest(path, { email: 1 }, 400);
    await guest(path, "{bad", 400);
    await guest(
      "/api/collections/_superusers/request-verification",
      { email: "test@example.com" },
      400,
    );
    await guest(
      "/api/collections/posts/request-verification",
      { email: "a@example.com" },
      404,
    );
    await guest(
      "/api/collections/missing/request-verification",
      { email: "a@example.com" },
      404,
    );
  });
});

describe("confirm-verification", () => {
  test("verifies with the mailed token; a reused token changes nothing", async () => {
    const ids = await createUser("c-verify@example.com");
    await guest(
      `${users}/request-verification`,
      { email: "c-verify@example.com" },
      204,
    );
    const tokens = await mailTokens("c-verify@example.com");
    const confirm = (t: Target) =>
      api(
        t,
        "POST",
        `${users}/confirm-verification`,
        { token: tokens[t.name] },
        null,
      );
    await same(confirm, 204);
    await getRecord(ids);
    await same(confirm, 204);
    await getRecord(ids);
  });

  test("a token is single use when verifying sets a random password", async () => {
    await createUser("m-verify@example.com", {}, "members");
    const path = "/api/collections/members";
    await guest(
      `${path}/request-verification`,
      { email: "m-verify@example.com" },
      204,
    );
    const tokens = await mailTokens("m-verify@example.com");
    const confirm = (t: Target) =>
      api(
        t,
        "POST",
        `${path}/confirm-verification`,
        { token: tokens[t.name] },
        null,
      );
    await same(confirm, 204);
    await same(confirm, 400);
  });

  test("rejects auth tokens, other flow tokens, other collections and bad input", async () => {
    await createUser("c-other@example.com");
    const auth = await loginBoth("c-other@example.com");
    await guest(
      `${users}/request-password-reset`,
      { email: "c-other@example.com" },
      204,
    );
    const reset = await mailTokens("c-other@example.com");
    const confirm = (token: Record<Target["name"], string>, path = users) =>
      same(
        (t) =>
          api(
            t,
            "POST",
            `${path}/confirm-verification`,
            { token: token[t.name] },
            null,
          ),
        400,
      );
    await confirm(auth);
    await confirm(reset);
    await guest(`${users}/confirm-verification`, {}, 400);
    await guest(`${users}/confirm-verification`, { token: "a.b.c" }, 400);
    await guest(
      "/api/collections/_superusers/confirm-verification",
      { token: "a.b.c" },
      400,
    );

    mail.pocketbase.clear();
    mail.heybe.clear();
    await guest(
      `${users}/request-verification`,
      { email: "c-other@example.com" },
      204,
    );
    await confirm(
      await mailTokens("c-other@example.com"),
      "/api/collections/members",
    );
  });

  test("a verification token is not an auth token", async () => {
    await createUser("c-noauth@example.com");
    await guest(
      `${users}/request-verification`,
      { email: "c-noauth@example.com" },
      204,
    );
    const tokens = await mailTokens("c-noauth@example.com");
    await same(
      (t) => api(t, "POST", `${users}/auth-refresh`, undefined, tokens[t.name]),
      401,
    );
  });
});

describe("password reset", () => {
  test("known and unknown emails both get 204 and only the known one a mail", async () => {
    await createUser("r-known@example.com");
    await guest(
      `${users}/request-password-reset`,
      { email: "r-nobody@example.com" },
      204,
    );
    await guest(
      `${users}/request-password-reset`,
      { email: "r-known@example.com" },
      204,
    );
    const tokens = await mailTokens("r-known@example.com");
    expect(claims(tokens.heybe)).toMatchObject({ type: "passwordReset" });
    expect(sentTo("r-nobody@example.com")).toEqual([0, 0]);
  });

  test("request validation and disabled password auth", async () => {
    const path = `${users}/request-password-reset`;
    await guest(path, {}, 400);
    await guest(path, { email: "nope" }, 400);
    await guest(
      "/api/collections/members/request-password-reset",
      { email: "a@example.com" },
      400,
    );
  });

  test("confirm sets the password, verifies, and kills the token and old sessions", async () => {
    const ids = await createUser("r-confirm@example.com");
    const old = await loginBoth("r-confirm@example.com");
    await guest(
      `${users}/request-password-reset`,
      { email: "r-confirm@example.com" },
      204,
    );
    const tokens = await mailTokens("r-confirm@example.com");
    const confirm = (t: Target) =>
      api(
        t,
        "POST",
        `${users}/confirm-password-reset`,
        {
          token: tokens[t.name],
          password: "newpass123",
          passwordConfirm: "newpass123",
        },
        null,
      );
    await same(confirm, 204);
    await getRecord(ids);
    await same(confirm, 400);
    await same(
      (t) => api(t, "POST", `${users}/auth-refresh`, undefined, old[t.name]),
      401,
    );
    await loginBoth("r-confirm@example.com", "newpass123");
  });

  test("confirm rejects bad input and tokens of other flows", async () => {
    await createUser("r-bad@example.com");
    const auth = await loginBoth("r-bad@example.com");
    await guest(
      `${users}/request-verification`,
      { email: "r-bad@example.com" },
      204,
    );
    const verify = await mailTokens("r-bad@example.com");
    const path = `${users}/confirm-password-reset`;
    for (const token of [auth, verify])
      await same(
        (t) =>
          api(
            t,
            "POST",
            path,
            {
              token: token[t.name],
              password: "x1234567",
              passwordConfirm: "x1234567",
            },
            null,
          ),
        400,
      );
    await guest(path, {}, 400);
    await guest(
      path,
      { token: "a.b.c", password: "1", passwordConfirm: "2" },
      400,
    );
    await guest(path, { password: "x".repeat(256) }, 400);
  });

  test("a password the field rejects fails on save", async () => {
    await createUser("r-long@example.com");
    await guest(
      `${users}/request-password-reset`,
      { email: "r-long@example.com" },
      204,
    );
    const tokens = await mailTokens("r-long@example.com");
    const long = "x".repeat(100);
    await same(
      (t) =>
        api(
          t,
          "POST",
          `${users}/confirm-password-reset`,
          { token: tokens[t.name], password: long, passwordConfirm: long },
          null,
        ),
      400,
    );
  });
});

describe("email change", () => {
  test("request guards: auth, collection and the new email", async () => {
    await createUser("e-owner@example.com");
    await createUser("e-taken@example.com");
    const auth = await loginBoth("e-owner@example.com");
    const path = `${users}/request-email-change`;
    const as = (body: unknown, status: number) =>
      same((t) => api(t, "POST", path, body, auth[t.name]), status);
    await guest(path, { newEmail: "x@example.com" }, 401);
    await same((t) => api(t, "POST", path, { newEmail: "x@example.com" }), 403);
    await same(
      (t) =>
        api(t, "POST", "/api/collections/_superusers/request-email-change", {
          newEmail: "x@example.com",
        }),
      400,
    );
    await same(
      (t) =>
        api(
          t,
          "POST",
          "/api/collections/members/request-email-change",
          { newEmail: "x@example.com" },
          auth[t.name],
        ),
      403,
    );
    await as({}, 400);
    await as({ newEmail: "nope" }, 400);
    await as({ newEmail: "e-owner@example.com" }, 400);
    await as({ newEmail: "e-taken@example.com" }, 400);
    await as({ newEmail: "E-TAKEN@example.com" }, 204);
    expect(sentTo("e-taken@example.com")).toEqual([0, 0]);
  });

  test("confirm needs the owner's password, changes the email once and ends old sessions", async () => {
    const ids = await createUser("e-change@example.com");
    await createUser("e-intruder@example.com", {
      password: "intruder1",
      passwordConfirm: "intruder1",
    });
    const auth = await loginBoth("e-change@example.com");
    await same(
      (t) =>
        api(
          t,
          "POST",
          `${users}/request-email-change`,
          { newEmail: "e-changed@example.com" },
          auth[t.name],
        ),
      204,
    );
    const tokens = await mailTokens("e-changed@example.com");
    expect(claims(tokens.heybe)).toMatchObject({
      type: "emailChange",
      email: "e-change@example.com",
      newEmail: "e-changed@example.com",
    });
    const confirm = (password: string, status: number) =>
      same(
        (t) =>
          api(
            t,
            "POST",
            `${users}/confirm-email-change`,
            { token: tokens[t.name], password },
            null,
          ),
        status,
      );
    await confirm("wrong-password", 400);
    await confirm("intruder1", 400);
    await guest(`${users}/confirm-email-change`, {}, 400);
    await confirm(PASSWORD, 204);
    await getRecord(ids);
    await confirm(PASSWORD, 400);
    await same(
      (t) => api(t, "POST", `${users}/auth-refresh`, undefined, auth[t.name]),
      401,
    );
    await loginBoth("e-changed@example.com");
  });

  test("confirm rejects other flow tokens and a new email taken meanwhile", async () => {
    await createUser("e-race@example.com");
    const auth = await loginBoth("e-race@example.com");
    await same(
      (t) =>
        api(
          t,
          "POST",
          `${users}/request-email-change`,
          { newEmail: "e-race-new@example.com" },
          auth[t.name],
        ),
      204,
    );
    const change = await mailTokens("e-race-new@example.com");
    await guest(
      `${users}/request-password-reset`,
      { email: "e-race@example.com" },
      204,
    );
    const reset = await mailTokens("e-race@example.com");
    const confirm = (token: Record<Target["name"], string>) =>
      same(
        (t) =>
          api(
            t,
            "POST",
            `${users}/confirm-email-change`,
            { token: token[t.name], password: PASSWORD },
            null,
          ),
        400,
      );
    await confirm(reset);
    await confirm(auth);
    await createUser("e-race-new@example.com");
    await confirm(change);
  });

  test("a failing mail server fails the request", async () => {
    await createUser("e-nomail@example.com");
    const auth = await loginBoth("e-nomail@example.com");
    await both((t) => api(t, "PATCH", "/api/settings", { smtp: { port: 1 } }));
    try {
      await same(
        (t) =>
          api(
            t,
            "POST",
            `${users}/request-email-change`,
            { newEmail: "e-nomail-new@example.com" },
            auth[t.name],
          ),
        400,
      );
    } finally {
      await both((t) =>
        api(t, "PATCH", "/api/settings", {
          smtp: { port: mail[t.name].port },
        }),
      );
    }
  });
});
