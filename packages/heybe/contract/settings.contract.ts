import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  SUPERUSER_EMAIL,
  SUPERUSER_PASSWORD,
  type Target,
  both,
  expectSame,
  startTargets,
} from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

beforeAll(async () => {
  targets = await startTargets();
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

const api = (
  t: Target,
  method: string,
  body?: unknown,
  token: string | null = t.superToken,
  path = "/api/settings",
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

const patch = (body: unknown, status: number) =>
  same((t) => api(t, "PATCH", body), status);

describe("settings", () => {
  test("GET returns the default settings without secrets", async () => {
    await same((t) => api(t, "GET"), 200);
  });

  test("PATCH meta.appName then GET", async () => {
    await patch({ meta: { appName: "Heybe" } }, 200);
    await same((t) => api(t, "GET"), 200);
  });

  test("a patch merges into the existing values", async () => {
    await patch({ smtp: { host: "mail.example.org", port: 25 } }, 200);
    await patch({ smtp: { tls: true }, logs: { maxDays: 7 } }, 200);
    await same((t) => api(t, "GET"), 200);
  });

  test("secrets are accepted but never returned", async () => {
    await patch(
      {
        smtp: { password: "secret" },
        s3: { secret: "secret" },
        backups: { s3: { secret: "secret" } },
      },
      200,
    );
    await same((t) => api(t, "GET"), 200);
    await patch({ meta: { appName: "Kept" } }, 200);
  });

  test("an enabled s3 config keeps using the stored secret", async () => {
    await patch({ s3: { secret: "stored" } }, 200);
    await patch(
      {
        s3: {
          enabled: true,
          bucket: "b",
          region: "r",
          endpoint: "http://localhost:9000",
          accessKey: "k",
        },
      },
      200,
    );
    await patch({ s3: { enabled: false } }, 200);
  });

  test("null zeroes a value and arrays are replaced", async () => {
    await patch(
      {
        trustedProxy: { headers: ["X-Real-IP", "X-Forwarded-For"] },
        superuserIPs: ["127.0.0.1", "::1", "10.0.0.0/8"],
      },
      200,
    );
    await patch({ trustedProxy: { headers: null }, smtp: { port: null } }, 200);
    await patch({ superuserIPs: [], smtp: { port: 587 } }, 200);
    await same((t) => api(t, "GET"), 200);
  });

  test("valid cron, ip and rate limit values are accepted", async () => {
    await patch({ backups: { cron: "@daily", cronMaxKeep: 2 } }, 200);
    await patch({ backups: { cron: "*/5 1-3 * * 1,2" } }, 200);
    await patch(
      { superuserIPs: ["fe80::/10", "192.168.1.0/24", "127.0.0.1", "::1"] },
      200,
    );
    await patch(
      {
        rateLimits: {
          enabled: true,
          excludedIPs: ["::1"],
          rules: [
            {
              label: "POST /api/x",
              audience: "@auth",
              duration: 2,
              maxRequests: 5,
            },
          ],
        },
      },
      200,
    );
    await same((t) => api(t, "GET"), 200);
  });

  test("keys match case-insensitively and unknown keys are ignored", async () => {
    await patch({ Meta: { AppName: "Cased", nope: 1 }, other: 1 }, 200);
  });

  test("Object.prototype names are ignored as unknown keys", async () => {
    await patch(
      '{"constructor":{},"toString":1,"meta":{"toString":{},"valueOf":1,"appName":"Proto"},"__proto__":{"x":1}}',
      200,
    );
    await same((t) => api(t, "GET"), 200);
  });

  test("an empty body changes nothing", async () => {
    await same((t) => api(t, "PATCH", ""), 200);
  });

  test("invalid values return the same field errors", async () => {
    for (const body of [
      { meta: { appName: "" } },
      {
        meta: {
          appURL: "nope",
          senderAddress: "bad",
          accentColor: "red",
          senderName: "",
        },
      },
      { meta: { accentColor: "#12345g" } },
      { meta: { appName: "x".repeat(256) } },
      { meta: null },
      { smtp: { enabled: true, host: "", port: 0, authMethod: "X" } },
      { smtp: { host: "a b", localName: "-bad-", port: -1 } },
      { s3: { enabled: true, endpoint: "zz" } },
      { backups: { cron: "bad", cronMaxKeep: 0, s3: { enabled: true } } },
      { backups: { cron: "* * * * *", cronMaxKeep: -1 } },
      { backups: { cron: "61 * * * *", cronMaxKeep: 1 } },
      { backups: { cron: "*/0 * * * *", cronMaxKeep: 1 } },
      { backups: { cron: "a * * * *", cronMaxKeep: 1 } },
      { backups: { cron: "5-1 * * * *", cronMaxKeep: 1 } },
      { batch: { enabled: true, maxRequests: 0, timeout: 0, maxBodySize: -1 } },
      { logs: { maxDays: -1, maxDataSize: -1, minLevel: 9007199254740993 } },
      { rateLimits: { enabled: true, rules: [], excludedIPs: ["x", ""] } },
      {
        rateLimits: {
          rules: [
            { label: "a b", audience: "x", duration: 0, maxRequests: 0 },
            { label: "/api/" },
          ],
        },
      },
      {
        rateLimits: {
          rules: [
            { label: "/api/x", duration: 1, maxRequests: 1 },
            { label: "/api/x", duration: 1, maxRequests: 1 },
          ],
        },
      },
      { superuserIPs: ["1.2.3.4", "bad", "1.2.3.4/33", ""] },
    ])
      await patch(body, 400);
  });

  test("bodies that cannot be loaded return the same error", async () => {
    for (const body of [
      { meta: "x" },
      { meta: { appName: 5 } },
      { smtp: { port: "587" } },
      { smtp: { port: 587.5 } },
      { superuserIPs: "1.2.3.4" },
      { rateLimits: { rules: [1] } },
      [1],
      '"x"',
      "garbage",
    ])
      await patch(body, 400);
  });

  test("a failed patch leaves the settings unchanged", async () => {
    await patch({ meta: { appName: "Before" } }, 200);
    await patch({ meta: { appName: "After", appURL: "nope" } }, 400);
    await same((t) => api(t, "GET"), 200);
  });
});

describe("settings authorization", () => {
  test("guests and invalid tokens are 401", async () => {
    for (const method of ["GET", "PATCH"]) {
      await same((t) => api(t, method, undefined, null), 401);
      await same((t) => api(t, method, undefined, "invalid"), 401);
    }
  });

  test("a non-superuser is 403", async () => {
    const tokens = new Map<string, string>();
    await both(async (t) => {
      const email = "settings-user@example.com";
      const body = JSON.stringify({
        email,
        password: "1234567890",
        passwordConfirm: "1234567890",
      });
      const headers = {
        "content-type": "application/json",
        authorization: t.superToken,
      };
      await fetch(`${t.url}/api/collections/users/records`, {
        method: "POST",
        headers,
        body,
      });
      const res = await fetch(
        `${t.url}/api/collections/users/auth-with-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: email, password: "1234567890" }),
        },
      );
      tokens.set(t.name, ((await res.json()) as { token: string }).token);
      return new Response("{}");
    });
    for (const method of ["GET", "PATCH"])
      await same((t) => api(t, method, undefined, tokens.get(t.name)!), 403);
  });
});

describe("superuser IP restriction", () => {
  test("a superuser outside the allowlist is 403, resolved through the trusted proxy header", async () => {
    await patch(
      {
        superuserIPs: ["127.0.0.1", "10.0.0.0/8"],
        trustedProxy: { headers: ["X-Real-IP"] },
      },
      200,
    );
    const from = (ip: string) => (t: Target) =>
      fetch(`${t.url}/api/settings`, {
        headers: { authorization: t.superToken, "x-real-ip": ip },
      });
    await same(from("10.2.3.4"), 200);
    await same(from("5.5.5.5"), 403);
    await same(from("not-an-ip"), 200);
    await same(
      (t) =>
        fetch(`${t.url}/api/settings`, {
          method: "PATCH",
          headers: {
            authorization: t.superToken,
            "x-real-ip": "127.0.0.1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ superuserIPs: [] }),
        }),
      200,
    );
    await same((t) => api(t, "GET"), 200);
  });

  test("a superuser password login outside the allowlist is 403", async () => {
    await patch(
      {
        superuserIPs: ["127.0.0.1"],
        trustedProxy: { headers: ["X-Real-IP"] },
      },
      200,
    );
    try {
      const login = (ip: string) => (t: Target) =>
        fetch(`${t.url}/api/collections/_superusers/auth-with-password`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": ip },
          body: JSON.stringify({
            identity: SUPERUSER_EMAIL,
            password: SUPERUSER_PASSWORD,
          }),
        });
      const [pb, hb] = await both(login("5.5.5.5"));
      expect(pb.status).toBe(403);
      expectSame(pb, hb);
      const [okPb, okHb] = await both(login("127.0.0.1"));
      expect(okPb.status).toBe(200);
      expect(okHb.status).toBe(200);
    } finally {
      await both((t) =>
        fetch(`${t.url}/api/settings`, {
          method: "PATCH",
          headers: {
            authorization: t.superToken,
            "x-real-ip": "127.0.0.1",
            "content-type": "application/json",
          },
          body: JSON.stringify({ superuserIPs: [] }),
        }),
      );
    }
  });
});
