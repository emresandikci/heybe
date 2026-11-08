import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Target, both, expectSame, startTargets } from "./harness";

const PASSWORD = "12345678";
const HEADERS = [
  "x-contract",
  "location",
  "vary",
  "x-frame-options",
  "x-content-type-options",
  "x-xss-protection",
  "cross-origin-opener-policy",
];

let targets: Awaited<ReturnType<typeof startTargets>>;
const users: Record<Target["name"], { id: string; token: string }[]> = {
  pocketbase: [],
  heybe: [],
};

async function createUser(t: Target, email: string) {
  const res = await fetch(`${t.url}/api/collections/users/records`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: t.superToken,
    },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      passwordConfirm: PASSWORD,
    }),
  });
  expect(res.status).toBe(200);
  const login = await fetch(
    `${t.url}/api/collections/users/auth-with-password`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: email, password: PASSWORD }),
    },
  );
  const { token, record } = (await login.json()) as {
    token: string;
    record: { id: string };
  };
  users[t.name].push({ id: record.id, token });
}

beforeAll(async () => {
  targets = await startTargets({
    heybeEntry: resolve(import.meta.dir, "extend/heybe.ts"),
    pbHooksDir: resolve(import.meta.dir, "extend/pb_hooks"),
  });
  for (const t of [targets.pb, targets.hb])
    for (const email of ["one@example.com", "two@example.com"])
      await createUser(t, email);
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

type Auth = "guest" | "superuser" | "user" | "other";

function token(t: Target, auth: Auth): Record<string, string> {
  if (auth === "superuser") return { authorization: t.superToken };
  if (auth === "user") return { authorization: users[t.name][0]!.token };
  if (auth === "other") return { authorization: users[t.name][1]!.token };
  return {};
}

async function same(
  method: string,
  path: (t: Target) => string,
  status: number,
  auth: Auth = "guest",
) {
  const [pb, hb] = await both(
    (t) =>
      fetch(`${t.url}${path(t)}`, {
        method,
        headers: token(t, auth),
        redirect: "manual",
      }),
    { headers: HEADERS },
  );
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

const at = (path: string) => () => path;

describe("custom routes", () => {
  test("GET /hello/{name} answers JSON with the global middleware header", async () => {
    const pb = await same("GET", at("/hello/world"), 200);
    expect(pb.headers["x-contract"]).toBe("global");
  });

  test("the global middleware also runs for the 404", async () => {
    const pb = await same("GET", at("/api/nope"), 404);
    expect(pb.headers["x-contract"]).toBe("global");
    expect(pb.headers["x-frame-options"]).toBe("SAMEORIGIN");
    await same("POST", at("/nope"), 404);
  });

  test("string, html, noContent and redirect", async () => {
    await same("GET", at("/text"), 200);
    await same("GET", at("/page"), 200);
    await same("DELETE", at("/nothing"), 204);
    const pb = await same("GET", at("/go"), 302);
    expect(pb.headers.location).toBe("/hello/redirected");
  });

  test("a thrown badRequestError keeps its message and safe data", async () => {
    await same("GET", at("/fail"), 400);
  });

  test("CORS and security headers on a custom route and its errors", async () => {
    for (const path of ["/hello/x", "/fail"]) {
      const [pb, hb] = await both(
        (t) =>
          fetch(`${t.url}${path}`, { headers: { origin: "http://x.test" } }),
        { headers: HEADERS },
      );
      expect(pb.headers.vary).toBe("Origin");
      expectSame(pb, hb);
    }
  });

  test("a plain thrown error is a 400", async () => {
    await same("GET", at("/throw"), 400);
  });

  test("?fields= applies to a custom JSON route", async () => {
    await same("GET", at("/hello/x?fields=message,meta.a"), 200);
  });
});

describe("auth middlewares", () => {
  test("requireAuth(users) on a group", async () => {
    await same("GET", at("/members/me"), 401);
    await same("GET", at("/members/me"), 403, "superuser");
    await same("GET", at("/members/me"), 200, "user");
  });

  test("requireSuperuserAuth", async () => {
    await same("GET", at("/admin"), 403, "user");
    await same("GET", at("/admin"), 200, "superuser");
  });

  test("requireSuperuserOrOwnerAuth", async () => {
    const own = (t: Target) => `/owner/${users[t.name][0]!.id}`;
    await same("GET", own, 401);
    await same("GET", own, 200, "user");
    await same("GET", own, 403, "other");
    await same("GET", own, 200, "superuser");
  });
});
