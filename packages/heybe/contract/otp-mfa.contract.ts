import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";
import { type SmtpCapture, startSmtpCapture } from "./smtp";

let targets: Awaited<ReturnType<typeof startTargets>>;
let mail: { pocketbase: SmtpCapture; heybe: SmtpCapture };

const PASSWORD = "12345678";
const otp = "/api/collections/otpusers";
type Ids = Record<Target["name"], string>;

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
  for (const name of ["otpusers", "otpother"])
    await both((t) =>
      api(t, "POST", "/api/collections", {
        name,
        type: "auth",
        otp: { enabled: true },
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

// Runs `fn` on both targets, compares the answers and returns one JSON field of each raw answer.
async function capture(
  fn: (t: Target) => Promise<Response>,
  field: string,
  status: number,
): Promise<Ids> {
  const values = {} as Ids;
  const [pb, hb] = await both(async (t) => {
    const res = await fn(t);
    const body = (await res.clone().json()) as Record<string, unknown>;
    values[t.name] = String(body[field] ?? "");
    return res;
  });
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return values;
}

const createUser = (email: string, collection = "otpusers") =>
  capture(
    (t) =>
      api(t, "POST", `/api/collections/${collection}/records`, {
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      }),
    "id",
    200,
  );

const targetList = () => [targets.pb, targets.hb];

const codeIn = (html: string) => /<strong>(\d+)<\/strong>/.exec(html)![1]!;

interface Requested {
  otpId: Ids;
  code: Ids;
}

// Requests an OTP on both targets, checks the answers are the same and returns each target's id and mailed code.
async function requestOtp(email: string, path = otp): Promise<Requested> {
  const otpId = await capture(
    (t) => api(t, "POST", `${path}/request-otp`, { email }, null),
    "otpId",
    200,
  );
  const [pb, hb] = await Promise.all([
    mail.pocketbase.waitFor(email),
    mail.heybe.waitFor(email),
  ]);
  await Promise.all(
    targetList().map(async (t) => {
      const filter = encodeURIComponent(`id='${otpId[t.name]}'&&sentTo!=''`);
      for (;;) {
        const res = await api(
          t,
          "GET",
          `/api/collections/_otps/records?filter=${filter}`,
        );
        if (((await res.json()) as { items: unknown[] }).items.length > 0)
          return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }),
  );
  expect(hb.subject).toBe(pb.subject);
  expect(codeIn(hb.html)).toHaveLength(codeIn(pb.html).length);
  return {
    otpId,
    code: { pocketbase: codeIn(pb.html), heybe: codeIn(hb.html) },
  };
}

const authWith =
  (r: Requested, path = otp, password?: string) =>
  (t: Target) =>
    api(
      t,
      "POST",
      `${path}/auth-with-otp`,
      { otpId: r.otpId[t.name], password: password ?? r.code[t.name] },
      null,
    );

describe("request-otp", () => {
  test("known email gets an otpId and a mail, unknown the same answer and no mail", async () => {
    await createUser("known@example.com");
    const known = await requestOtp("known@example.com");
    expect(known.code.heybe).toMatch(/^\d{8}$/);
    await guest(`${otp}/request-otp`, { email: "nobody@example.com" }, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const m of [mail.pocketbase, mail.heybe])
      expect(
        m.messages().filter((x) => x.recipients.includes("nobody@example.com")),
      ).toHaveLength(0);
  });

  test("validation, disabled and collection errors", async () => {
    const path = `${otp}/request-otp`;
    await guest(path, {}, 400);
    await guest(path, { email: "nope" }, 400);
    await guest(path, { email: `${"a".repeat(250)}@example.com` }, 400);
    await guest(path, { email: 1 }, 400);
    await guest(path, "{bad", 400);
    await guest(
      "/api/collections/users/request-otp",
      { email: "a@example.com" },
      403,
    );
    await guest(
      "/api/collections/posts/request-otp",
      { email: "a@example.com" },
      404,
    );
    await guest(
      "/api/collections/missing/request-otp",
      { email: "a@example.com" },
      404,
    );
  });

  test("after 10 unexpired OTPs the last one is reused and no mail is sent", async () => {
    await createUser("many@example.com");
    const request = () =>
      capture(
        (t) =>
          api(
            t,
            "POST",
            `${otp}/request-otp`,
            { email: "many@example.com" },
            null,
          ),
        "otpId",
        200,
      );
    let last = {} as Ids;
    for (let i = 0; i < 10; i++) last = await request();
    const sentCount = () =>
      [mail.pocketbase, mail.heybe].map(
        (m) =>
          m.messages().filter((x) => x.recipients.includes("many@example.com"))
            .length,
      );
    while (sentCount().some((n) => n < 10))
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await request()).toEqual(last);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentCount()).toEqual([10, 10]);
  });
});

describe("auth-with-otp", () => {
  test("logs in once with the mailed code, verifies the email and drops the password", async () => {
    const ids = await createUser("login@example.com");
    const r = await requestOtp("login@example.com");
    await same(authWith(r), 200);
    await same(authWith(r), 400);
    await same((t) => api(t, "GET", `${otp}/records/${ids[t.name]}`), 200);
    await same(
      (t) =>
        api(
          t,
          "POST",
          `${otp}/auth-with-password`,
          { identity: "login@example.com", password: PASSWORD },
          null,
        ),
      400,
    );
  });

  test("the token works for auth-refresh", async () => {
    await createUser("refresh@example.com");
    const r = await requestOtp("refresh@example.com");
    const tokens = await capture(authWith(r), "token", 200);
    await same(
      (t) => api(t, "POST", `${otp}/auth-refresh`, undefined, tokens[t.name]),
      200,
    );
  });

  test("a wrong code fails and the OTP stays usable", async () => {
    await createUser("wrong@example.com");
    const r = await requestOtp("wrong@example.com");
    const wrong = r.code.heybe === "00000000" ? "11111111" : "00000000";
    await same(authWith(r, otp, wrong), 400);
    await same(authWith(r), 200);
  });

  test("an otpId of another collection fails", async () => {
    await createUser("cross@example.com");
    const r = await requestOtp("cross@example.com");
    await same(authWith(r, "/api/collections/otpother"), 400);
    await same(authWith(r), 200);
  });

  test("unknown ids and bad input", async () => {
    const path = `${otp}/auth-with-otp`;
    await guest(path, {}, 400);
    await guest(path, { otpId: "x".repeat(256), password: "1" }, 400);
    await guest(path, { otpId: "x", password: "1".repeat(72) }, 400);
    await guest(path, { otpId: "missing", password: "123456" }, 400);
    await guest(path, { otpId: 1, password: "123456" }, 400);
    await guest(path, "{bad", 400);
    await guest(
      "/api/collections/users/auth-with-otp",
      { otpId: "x", password: "1" },
      403,
    );
    await guest(
      "/api/collections/posts/auth-with-otp",
      { otpId: "x", password: "1" },
      404,
    );
  });

  test("the 6th attempt is rate limited even with the right code", async () => {
    await createUser("limit@example.com");
    const r = await requestOtp("limit@example.com");
    for (let i = 0; i < 5; i++) await same(authWith(r, otp, "x"), 400);
    await same(authWith(r), 429);
  });

  test("a password change drops pending OTPs", async () => {
    const ids = await createUser("pwchange@example.com");
    const r = await requestOtp("pwchange@example.com");
    await same(
      (t) =>
        api(t, "PATCH", `${otp}/records/${ids[t.name]}`, {
          password: "newpass123",
          passwordConfirm: "newpass123",
        }),
      200,
    );
    await same(authWith(r), 400);
  });
});

describe("auth-methods", () => {
  test("reports the otp config", async () => {
    await same(
      (t) => api(t, "GET", `${otp}/auth-methods`, undefined, null),
      200,
    );
    await same(
      (t) =>
        api(t, "GET", "/api/collections/users/auth-methods", undefined, null),
      200,
    );
  });
});
