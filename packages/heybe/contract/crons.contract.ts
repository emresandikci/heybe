import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { type Target, both, expectSame, startTargets } from "./harness";

const PASSWORD = "12345678";

let targets: Awaited<ReturnType<typeof startTargets>>;
const userTokens: Record<Target["name"], string> = {
  pocketbase: "",
  heybe: "",
};

beforeAll(async () => {
  targets = await startTargets({
    heybeEntry: resolve(import.meta.dir, "extend/heybe.ts"),
    pbHooksDir: resolve(import.meta.dir, "extend/pb_hooks"),
  });
  for (const t of [targets.pb, targets.hb]) {
    const email = "cron@example.com";
    const created = await fetch(`${t.url}/api/collections/users/records`, {
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
    expect(created.status).toBe(200);
    const login = await fetch(
      `${t.url}/api/collections/users/auth-with-password`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: email, password: PASSWORD }),
      },
    );
    userTokens[t.name] = ((await login.json()) as { token: string }).token;
  }
}, 60_000);

afterAll(async () => {
  await targets.stop();
});

async function same(
  method: string,
  path: string,
  status: number,
  auth: "guest" | "superuser" | "user",
) {
  const [pb, hb] = await both(
    (t) =>
      fetch(`${t.url}${path}`, {
        method,
        headers:
          auth === "superuser"
            ? { authorization: t.superToken }
            : auth === "user"
              ? { authorization: userTokens[t.name] }
              : {},
      }),
    { headers: ["x-contract"] },
  );
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return pb;
}

describe("crons api", () => {
  test("list as a superuser: own ids alphabetically, then the system ones", async () => {
    await same("GET", "/api/crons", 200, "superuser");
    for (const t of [targets.pb, targets.hb]) {
      const res = await fetch(`${t.url}/api/crons`, {
        headers: { authorization: t.superToken },
      });
      const jobs = (await res.json()) as { id: string; expression: string }[];
      expect(jobs.map((j) => j.id)).toEqual([
        "alpha",
        "zeta",
        "__pbDBOptimize__",
        "__pbMFACleanup__",
        "__pbOTPCleanup__",
        "__pbLogsCleanup__",
      ]);
      expect(jobs[0]!.expression).toBe("0 * * * *");
    }
  });

  test("list as a guest is 401 and as a user 403", async () => {
    await same("GET", "/api/crons", 401, "guest");
    await same("GET", "/api/crons", 403, "user");
  });

  test("run answers 204, unknown ids 404, non superusers are refused", async () => {
    await same("POST", "/api/crons/__pbDBOptimize__", 204, "superuser");
    await same("POST", "/api/crons/missing", 404, "superuser");
    await same("POST", "/api/crons/alpha", 401, "guest");
    await same("POST", "/api/crons/alpha", 403, "user");
  });
});
