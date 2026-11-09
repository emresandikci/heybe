import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";

let targets: Awaited<ReturnType<typeof startTargets>>;

type Json = Record<string, any>;
type Rule = { label: string; maxRequests: number; audience?: string };

const users: Record<Target["name"], { token: string }> = {
  pocketbase: { token: "" },
  heybe: { token: "" },
};
const fileUrls: Record<Target["name"], string> = { pocketbase: "", heybe: "" };

function send(
  t: Target,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(opts.body instanceof FormData
        ? {}
        : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: opts.token } : {}),
    },
    body:
      opts.body === undefined || opts.body instanceof FormData
        ? (opts.body as FormData | undefined)
        : JSON.stringify(opts.body),
  });
}

async function settings(t: Target, patch: Json): Promise<void> {
  const res = await send(t, "PATCH", "/api/settings", {
    token: t.superToken,
    body: patch,
  });
  expect(res.status).toBe(200);
}

// a settings save resets every counter, so each test starts fresh
const limit = (rules: Rule[], excludedIPs: string[] = []) =>
  Promise.all(
    [targets.pb, targets.hb].map((t) =>
      settings(t, {
        rateLimits: {
          enabled: true,
          excludedIPs,
          rules: rules.map((r) => ({ audience: "", duration: 60, ...r })),
        },
      }),
    ),
  );

// sends `n` times on both: same statuses, and same bodies for errors
async function sameStatuses(
  n: number,
  fn: (t: Target) => Promise<Response>,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const [pb, hb] = await both(fn);
    if (pb.status >= 400) expectSame(pb, hb);
    else expect(hb.status).toBe(pb.status);
    out.push(pb.status);
  }
  return out;
}

beforeAll(async () => {
  targets = await startTargets();
  await Promise.all(
    [targets.pb, targets.hb].map(async (t) => {
      const token = t.superToken;
      await settings(t, { batch: { enabled: true } });
      const created = await send(t, "POST", "/api/collections", {
        token,
        body: {
          name: "rl_posts",
          type: "base",
          listRule: "",
          createRule: "",
          fields: [
            { name: "title", type: "text" },
            { name: "doc", type: "file", maxSelect: 1, maxSize: 1000 },
          ],
        },
      });
      expect(created.status).toBe(200);
      const data = new FormData();
      data.append("doc", new File(["hello"], "doc.txt"));
      const record = (await (
        await send(t, "POST", "/api/collections/rl_posts/records", {
          token,
          body: data,
        })
      ).json()) as Json;
      fileUrls[t.name] =
        `/api/files/rl_posts/${record.id}/${encodeURIComponent(record.doc)}`;
      const user = await send(t, "POST", "/api/collections/users/records", {
        token,
        body: {
          email: "rl@example.com",
          password: "1234567890",
          passwordConfirm: "1234567890",
        },
      });
      expect(user.status).toBe(200);
      const auth = await send(
        t,
        "POST",
        "/api/collections/users/auth-with-password",
        { body: { identity: "rl@example.com", password: "1234567890" } },
      );
      users[t.name].token = ((await auth.json()) as Json).token;
    }),
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

const health = (t: Target, token?: string) =>
  send(t, "GET", "/api/health", { token });

describe("rate limits", () => {
  test("*:list limits the third list", async () => {
    await limit([{ label: "*:list", maxRequests: 2 }]);
    expect(
      await sameStatuses(3, (t) =>
        send(t, "GET", "/api/collections/rl_posts/records"),
      ),
    ).toEqual([200, 200, 429]);
  });

  test("the /api/ prefix limits GET /api/health", async () => {
    await limit([{ label: "/api/", maxRequests: 1 }]);
    expect(await sameStatuses(2, (t) => health(t))).toEqual([200, 429]);
  });

  test("@guest and @auth audiences", async () => {
    await limit([
      { label: "/api/health", maxRequests: 1, audience: "@guest" },
      { label: "GET /api/health", maxRequests: 2, audience: "@auth" },
    ]);
    expect(await sameStatuses(2, (t) => health(t))).toEqual([200, 429]);
    expect(
      await sameStatuses(3, (t) => health(t, users[t.name].token)),
    ).toEqual([200, 200, 429]);
  });

  test("*:auth limits auth-with-password", async () => {
    await limit([{ label: "*:auth", maxRequests: 1 }]);
    expect(
      await sameStatuses(2, (t) =>
        send(t, "POST", "/api/collections/users/auth-with-password", {
          body: { identity: "rl@example.com", password: "wrong-password" },
        }),
      ),
    ).toEqual([400, 429]);
  });

  test("/api/batch and its sub-requests per collection", async () => {
    await limit([
      { label: "/api/batch", maxRequests: 2 },
      { label: "rl_posts:create", maxRequests: 1 },
    ]);
    const create = {
      method: "POST",
      url: "/api/collections/rl_posts/records",
      body: { title: "a" },
    };
    expect(
      await sameStatuses(3, (t) =>
        send(t, "POST", "/api/batch", { body: { requests: [create, create] } }),
      ),
    ).toEqual([400, 400, 429]);
    expect(
      await sameStatuses(2, (t) =>
        send(t, "POST", "/api/collections/rl_posts/records", { body: {} }),
      ),
    ).toEqual([200, 429]);
  });

  test("file download uses the file tag", async () => {
    await limit([{ label: "*:file", maxRequests: 1 }]);
    expect(
      await sameStatuses(2, (t) => send(t, "GET", fileUrls[t.name])),
    ).toEqual([200, 429]);
    expect(
      await sameStatuses(1, (t) =>
        send(t, "GET", "/api/files/rl_missing/abc/a.txt"),
      ),
    ).toEqual([404]);
  });

  test("superusers bypass every limiter", async () => {
    await limit([{ label: "/api/", maxRequests: 1 }]);
    expect(await sameStatuses(3, (t) => health(t, t.superToken))).toEqual([
      200, 200, 200,
    ]);
  });

  test("excludedIPs skip every limiter", async () => {
    await limit([{ label: "/api/", maxRequests: 1 }], ["127.0.0.1"]);
    expect(await sameStatuses(3, (t) => health(t))).toEqual([200, 200, 200]);
  });

  test("the cleanup cron is listed after the first limited request", async () => {
    await limit([{ label: "/api/health", maxRequests: 5 }]);
    const cronIds = async (t: Target) => {
      const res = await send(t, "GET", "/api/crons", { token: t.superToken });
      return ((await res.json()) as Json[]).map((c) => c.id);
    };
    for (const t of [targets.pb, targets.hb])
      expect(await cronIds(t)).not.toContain("__pbRateLimitersCleanup__");
    await sameStatuses(1, (t) => health(t));
    for (const t of [targets.pb, targets.hb])
      expect(await cronIds(t)).toContain("__pbRateLimitersCleanup__");
  });
});
