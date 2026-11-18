import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";
import { type SmtpCapture, startSmtpCapture } from "./smtp";

let targets: Awaited<ReturnType<typeof startTargets>>;
let mail: { pocketbase: SmtpCapture; heybe: SmtpCapture };

const PASSWORD = "12345678";

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
      name: "alertmfa",
      type: "auth",
      otp: { enabled: true },
      mfa: { enabled: true },
    }),
  );
  for (const [name, enabled] of [
    ["alertusers", true],
    ["noalerts", false],
  ] as const)
    await both((t) =>
      api(t, "POST", "/api/collections", {
        name,
        type: "auth",
        otp: { enabled: true },
        authAlert: { enabled },
      }),
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
  headers: Record<string, string> = {},
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(headers.authorization ? {} : { authorization: t.superToken }),
      ...headers,
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

const createUser = (collection: string, email: string) =>
  same(
    (t) =>
      api(t, "POST", `/api/collections/${collection}/records`, {
        email,
        password: PASSWORD,
        passwordConfirm: PASSWORD,
      }),
    200,
  );

const login = (collection: string, email: string, agent: string, query = "") =>
  both((t) =>
    fetch(`${t.url}/api/collections/${collection}/auth-with-password${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": agent },
      body: JSON.stringify({ identity: email, password: PASSWORD }),
    }),
  );

// PocketBase sends before it answers; Heybe sends right after, which a round trip always outlasts.
async function alertCounts(address: string): Promise<number[]> {
  await both((t) => api(t, "GET", "/api/health"));
  return [mail.pocketbase, mail.heybe].map(
    (m) => m.messages().filter((x) => x.recipients.includes(address)).length,
  );
}

describe("login alerts", () => {
  test("first login sends nothing, a new user agent sends the alert, the same one again does not", async () => {
    const email = "alert@example.com";
    await createUser("alertusers", email);

    let [pb, hb] = await login("alertusers", email, "agent-one");
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
    expect(await alertCounts(email)).toEqual([0, 0]);

    [pb, hb] = await login("alertusers", email, "agent-two <b>");
    expect(pb.status).toBe(200);
    expectSame(pb, hb);
    const [pbMail, hbMail] = await Promise.all([
      mail.pocketbase.waitFor(email),
      mail.heybe.waitFor(email),
    ]);
    expect(hbMail.subject).toBe(pbMail.subject);
    const info = (html: string) =>
      /<em>\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z - (.*)<\/em>/.exec(html)![1];
    expect(info(hbMail.html)).toBe(info(pbMail.html));
    expect(info(hbMail.html)).toContain("agent-two &lt;b&gt;");
    expect(await alertCounts(email)).toEqual([1, 1]);

    await login("alertusers", email, "agent-two <b>");
    expect(await alertCounts(email)).toEqual([1, 1]);
  });

  test("a password change forgets the origins so the next login is a first login", async () => {
    const email = "reset@example.com";
    await createUser("alertusers", email);
    await login("alertusers", email, "agent-one");
    const ids = await Promise.all(
      [targets.pb, targets.hb].map(async (t) => {
        const res = await api(
          t,
          "GET",
          `/api/collections/alertusers/records?filter=${encodeURIComponent(`email='${email}'`)}`,
        );
        return ((await res.json()) as { items: { id: string }[] }).items[0]!.id;
      }),
    );
    await Promise.all(
      [targets.pb, targets.hb].map((t, i) =>
        api(t, "PATCH", `/api/collections/alertusers/records/${ids[i]}`, {
          password: "87654321",
          passwordConfirm: "87654321",
        }),
      ),
    );
    await both((t) =>
      fetch(`${t.url}/api/collections/alertusers/auth-with-password`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "other" },
        body: JSON.stringify({ identity: email, password: "87654321" }),
      }),
    );
    expect(await alertCounts(email)).toEqual([0, 0]);
  });

  test("a disabled alert sends nothing", async () => {
    const email = "quiet@example.com";
    await createUser("noalerts", email);
    await login("noalerts", email, "agent-one");
    await login("noalerts", email, "agent-two");
    expect(await alertCounts(email)).toEqual([0, 0]);
  });

  test("auth-refresh never alerts", async () => {
    const email = "refresh@example.com";
    await createUser("alertusers", email);
    const tokens = {} as Record<Target["name"], string>;
    await login("alertusers", email, "agent-one");
    await both(async (t) => {
      const res = await fetch(
        `${t.url}/api/collections/alertusers/auth-with-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: email, password: PASSWORD }),
        },
      );
      tokens[t.name] = ((await res.clone().json()) as { token: string }).token;
      return res;
    });
    const before = await alertCounts(email);
    await both((t) =>
      api(t, "POST", "/api/collections/alertusers/auth-refresh", undefined, {
        authorization: tokens[t.name],
        "user-agent": "agent-three",
      }),
    );
    expect(await alertCounts(email)).toEqual(before);
  });
});

describe("fields on auth responses", () => {
  const query = "?fields=record.email,record.collectionName";

  test("auth-with-password", async () => {
    await createUser("alertusers", "fields@example.com");
    const [pb, hb] = await login(
      "alertusers",
      "fields@example.com",
      "a",
      query,
    );
    expect(pb.status).toBe(200);
    expect(pb.body).toEqual({
      record: { email: "fields@example.com", collectionName: "alertusers" },
    });
    expectSame(pb, hb);
  });

  test("auth-refresh", async () => {
    const tokens = {} as Record<Target["name"], string>;
    await both(async (t) => {
      const res = await fetch(
        `${t.url}/api/collections/alertusers/auth-with-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            identity: "fields@example.com",
            password: PASSWORD,
          }),
        },
      );
      tokens[t.name] = ((await res.clone().json()) as { token: string }).token;
      return res;
    });
    await same(
      (t) =>
        api(
          t,
          "POST",
          `/api/collections/alertusers/auth-refresh${query}`,
          undefined,
          { authorization: tokens[t.name] },
        ),
      200,
    );
  });

  test("auth-with-otp", async () => {
    const email = "fieldsotp@example.com";
    await createUser("alertusers", email);
    const otpIds = {} as Record<Target["name"], string>;
    await both(async (t) => {
      const res = await api(
        t,
        "POST",
        "/api/collections/alertusers/request-otp",
        { email },
      );
      otpIds[t.name] = ((await res.clone().json()) as { otpId: string }).otpId;
      return res;
    });
    const [pbMail, hbMail] = await Promise.all([
      mail.pocketbase.waitFor(email),
      mail.heybe.waitFor(email),
    ]);
    const codes = {
      pocketbase: /<strong>(\d+)<\/strong>/.exec(pbMail.html)![1],
      heybe: /<strong>(\d+)<\/strong>/.exec(hbMail.html)![1],
    };
    await same(
      (t) =>
        api(t, "POST", `/api/collections/alertusers/auth-with-otp${query}`, {
          otpId: otpIds[t.name],
          password: codes[t.name],
        }),
      200,
    );
  });

  test("an MFA challenge answer is not picked", async () => {
    await createUser("alertmfa", "fieldsmfa@example.com");
    const [pb, hb] = await login(
      "alertmfa",
      "fieldsmfa@example.com",
      "a",
      "?fields=nothing",
    );
    expect(pb.status).toBe(401);
    expectSame(pb, hb);
  });
});
