import { describe, expect, test } from "bun:test";
import { createClientWith, type ClientOptions } from "./client.js";
import { fakeEnv, jwt } from "./test-env.js";

const user = { id: "u1", collectionId: "c1", collectionName: "users" };
const admin = {
  id: "s1",
  collectionId: "pbc_3142635823",
  collectionName: "_superusers",
};
const tokenFor = (rec: typeof user, exp: number) =>
  jwt({ id: rec.id, collectionId: rec.collectionId, type: "auth", exp });

const fresh = tokenFor(user, 10_000);
const expiring = tokenFor(user, 30);

function setup(opts: ClientOptions = {}, refreshStatus = 200) {
  const env = fakeEnv();
  const client = createClientWith("http://a", opts, env);
  env.respond((req) => {
    if (req.url.endsWith("/auth-refresh"))
      return refreshStatus === 200
        ? Response.json({ token: fresh, record: user })
        : Response.json({ message: "no" }, { status: refreshStatus });
    return Response.json({});
  });
  const paths = () => env.requests.map((r) => new URL(r.url).pathname);
  return { env, client, paths };
}

describe("auto refresh", () => {
  test("no threshold, no refresh", async () => {
    const { client, paths } = setup();
    client.authStore.save(expiring, user);
    await client.send("/x");
    expect(paths()).toEqual(["/x"]);
  });

  test("token far from expiry, no refresh", async () => {
    const { client, paths } = setup({ autoRefreshThreshold: 60 });
    client.authStore.save(tokenFor(user, 1000), user);
    await client.send("/x");
    expect(paths()).toEqual(["/x"]);
  });

  test("five parallel requests near expiry send exactly one auth-refresh and all carry the new token", async () => {
    const { env, client, paths } = setup({ autoRefreshThreshold: 60 });
    client.authStore.save(expiring, user);
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) => client.send(`/x${i}`, { requestKey: null })),
    );
    expect(paths().filter((p) => p.endsWith("/auth-refresh"))).toEqual([
      "/api/collections/users/auth-refresh",
    ]);
    expect(env.requests[0]!.headers.get("Authorization")).toBe(expiring);
    const rest = env.requests.slice(1);
    expect(rest).toHaveLength(5);
    for (const r of rest) expect(r.headers.get("Authorization")).toBe(fresh);
    expect(client.authStore.token).toBe(fresh);
  });

  test("a request with its own Authorization skips the refresh", async () => {
    const { client, paths } = setup({ autoRefreshThreshold: 60 });
    client.authStore.save(expiring, user);
    await client.send("/x", { headers: { authorization: "mine" } });
    expect(paths()).toEqual(["/x"]);
  });

  test("refresh failure still sends the request", async () => {
    const { env, client, paths } = setup({ autoRefreshThreshold: 60 }, 401);
    client.authStore.save(expiring, user);
    await client.send("/x");
    expect(paths()).toEqual(["/api/collections/users/auth-refresh", "/x"]);
    expect(env.requests[1]!.headers.get("Authorization")).toBe(expiring);
    expect(client.authStore.token).toBe(expiring);
  });

  test("superuser reauthenticates with stored credentials when refresh fails", async () => {
    const { env, client, paths } = setup({}, 401);
    const logins = [tokenFor(admin, 30), tokenFor(admin, 10_000)];
    env.respond((req) => {
      if (req.url.endsWith("/auth-with-password"))
        return Response.json({ token: logins.shift(), record: admin });
      if (req.url.endsWith("/auth-refresh"))
        return Response.json({}, { status: 401 });
      return Response.json({});
    });
    await client
      .auth("_superusers")
      .withPassword("a@b.c", "pw", { autoRefreshThreshold: 60 });
    await client.send("/x");
    const login = "/api/collections/_superusers/auth-with-password";
    expect(paths()).toEqual([
      login,
      "/api/collections/_superusers/auth-refresh",
      login,
      "/x",
    ]);
    expect(JSON.parse(String(env.requests[2]!.body))).toEqual({
      identity: "a@b.c",
      password: "pw",
    });
    expect(env.requests[3]!.headers.get("Authorization")).toBe(
      tokenFor(admin, 10_000),
    );

    await env.advance(20_000_000);
    logins.push(tokenFor(admin, 50_000));
    await client.send("/y");
    expect(paths().slice(4)).toEqual([login, "/y"]);
  });

  test("superuser registration resets after clear", async () => {
    const { env, client, paths } = setup({}, 401);
    env.respond((req) =>
      req.url.endsWith("/auth-with-password")
        ? Response.json({ token: tokenFor(admin, 30), record: admin })
        : Response.json({}),
    );
    await client
      .auth("_superusers")
      .withPassword("a@b.c", "pw", { autoRefreshThreshold: 60 });
    client.authStore.clear();
    client.authStore.save(tokenFor(admin, 30), admin);
    await client.send("/x");
    expect(paths()).toEqual([
      "/api/collections/_superusers/auth-with-password",
      "/x",
    ]);
  });

  const login = "/api/collections/_superusers/auth-with-password";

  // answers each superuser login with the next token, or with the status when it is a number
  function adminSetup(logins: (string | number)[], opts: ClientOptions = {}) {
    const ctx = setup(opts);
    ctx.env.respond((req) => {
      if (req.url.includes("/auth-with-password")) {
        const next = logins.shift()!;
        return typeof next === "number"
          ? Response.json({ message: "no" }, { status: next })
          : Response.json({ token: next, record: admin });
      }
      if (req.url.endsWith("/auth-refresh"))
        return Response.json({}, { status: 401 });
      return Response.json({});
    });
    return { ...ctx, supers: ctx.client.auth("_superusers") };
  }

  test("a failed superuser re-login rejects all parallel waiters", async () => {
    const { env, client, paths, supers } = adminSetup([
      tokenFor(admin, 30),
      400,
    ]);
    await supers.withPassword("a@b.c", "pw", {
      autoRefreshThreshold: 60,
      expand: { team: true },
      mfaId: "m1",
      requestKey: "k",
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) => client.send(`/x${i}`, { requestKey: null })),
    );
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason.status).toBe(400);
    }
    expect(paths()).toEqual([
      login,
      "/api/collections/_superusers/auth-refresh",
      login,
    ]);
    expect(env.requests[2]!.url).toEndWith(`${login}?expand=team`);
    expect(JSON.parse(String(env.requests[2]!.body))).toEqual({
      identity: "a@b.c",
      password: "pw",
    });
  });

  test("a superuser login without threshold drops the re-login", async () => {
    const { client, paths, supers } = adminSetup([
      tokenFor(admin, 30),
      tokenFor(admin, 30),
    ]);
    await supers.withPassword("a@b.c", "pw", { autoRefreshThreshold: 60 });
    await supers.withPassword("a@b.c", "pw");
    await client.send("/x");
    expect(paths()).toEqual([login, login, "/x"]);
  });

  test("a failed superuser login drops the re-login", async () => {
    const first = tokenFor(admin, 30);
    const { client, paths, supers } = adminSetup([first, 400]);
    await supers.withPassword("a@b.c", "pw", { autoRefreshThreshold: 60 });
    await expect(supers.withPassword("a@b.c", "bad")).rejects.toMatchObject({
      status: 400,
    });
    await client.send("/x");
    expect(paths()).toEqual([login, login, "/x"]);
    expect(client.authStore.token).toBe(first);
  });

  test("repeated requests after a failed refresh try again", async () => {
    const { client, paths } = setup({ autoRefreshThreshold: 60 }, 401);
    client.authStore.save(expiring, user);
    await client.send("/x");
    await client.send("/y");
    const refresh = "/api/collections/users/auth-refresh";
    expect(paths()).toEqual([refresh, "/x", refresh, "/y"]);
  });

  test("a non-superuser withPassword never registers a re-login", async () => {
    const { env, client, paths } = setup({ autoRefreshThreshold: 60 }, 401);
    env.respond((req) =>
      req.url.endsWith("/auth-with-password")
        ? Response.json({ token: expiring, record: user })
        : req.url.endsWith("/auth-refresh")
          ? Response.json({}, { status: 401 })
          : Response.json({}),
    );
    await client
      .auth("users")
      .withPassword("a@b.c", "pw", { autoRefreshThreshold: 60 });
    await client.send("/x");
    expect(paths()).toEqual([
      "/api/collections/users/auth-with-password",
      "/api/collections/users/auth-refresh",
      "/x",
    ]);
  });

  test("an auto refresh finishing after the store changed is not saved", async () => {
    const { env, client, paths } = setup({ autoRefreshThreshold: 60 });
    const { promise, resolve } = Promise.withResolvers<Response>();
    env.respond((req) =>
      req.url.endsWith("/auth-refresh") ? promise : Response.json({}),
    );
    client.authStore.save(expiring, user);
    const sent = client.send("/x");
    await env.advance(0);
    expect(paths()).toEqual(["/api/collections/users/auth-refresh"]);
    client.authStore.clear();
    resolve(Response.json({ token: fresh, record: user }));
    await sent;
    expect(client.authStore.token).toBe("");
    expect(client.authStore.record).toBeNull();
    expect(env.requests[1]!.headers.get("Authorization")).toBeNull();
  });
});
