import { describe, expect, test } from "bun:test";
import { createClientWith } from "./client.js";
import { HeybeError } from "./error.js";
import { fakeEnv, jwt } from "./test-env.js";

const user = { id: "u1", collectionId: "c1", collectionName: "users" };
const token = jwt({ id: "u1", collectionId: "c1", type: "auth", exp: 1e10 });

function setup() {
  const env = fakeEnv();
  const client = createClientWith("http://a", {}, env);
  env.respond(() => Response.json({ token, record: user }));
  const body = (i = 0) => JSON.parse(String(env.requests[i]!.body ?? "null"));
  return { env, client, body, users: client.auth("users") };
}

const base = "http://a/api/collections/users";

describe("auth", () => {
  test("methods", async () => {
    const { env, users } = setup();
    env.respond(() => Response.json({ password: { enabled: true } }));
    expect((await users.methods()).password.enabled).toBe(true);
    expect(env.requests[0]!.method).toBe("GET");
    expect(env.requests[0]!.url).toBe(
      `${base}/auth-methods?fields=mfa%2Cotp%2Cpassword%2Coauth2`,
    );
  });

  test("withPassword saves the store", async () => {
    const { env, client, body, users } = setup();
    const res = await users.withPassword("a@b.c", "pw");
    expect(res).toEqual({ token, record: user } as never);
    expect(env.requests[0]!.method).toBe("POST");
    expect(env.requests[0]!.url).toBe(`${base}/auth-with-password`);
    expect(body()).toEqual({ identity: "a@b.c", password: "pw" });
    expect(client.authStore.token).toBe(token);
    expect(client.authStore.record).toEqual(user);
  });

  test("withPassword passes mfaId and expand", async () => {
    const { env, body, users } = setup();
    await users.withPassword("a@b.c", "pw", {
      mfaId: "m1",
      expand: { team: true },
    });
    expect(env.requests[0]!.url).toBe(`${base}/auth-with-password?expand=team`);
    expect(body()).toEqual({ identity: "a@b.c", password: "pw", mfaId: "m1" });
  });

  test("MFA 401 exposes response.mfaId", async () => {
    const { env, client, users } = setup();
    env.respond(() =>
      Response.json(
        { mfaId: "m1", status: 401, message: "MFA required" },
        { status: 401 },
      ),
    );
    const err = await users.withPassword("a@b.c", "pw").catch((e) => e);
    expect(err).toBeInstanceOf(HeybeError);
    expect(err.status).toBe(401);
    expect(err.response.mfaId).toBe("m1");
    expect(client.authStore.token).toBe("");
  });

  test("requestOTP", async () => {
    const { env, body, users } = setup();
    env.respond(() => Response.json({ otpId: "o1" }));
    expect(await users.requestOTP("a@b.c")).toEqual({ otpId: "o1" });
    expect(env.requests[0]!.url).toBe(`${base}/request-otp`);
    expect(body()).toEqual({ email: "a@b.c" });
  });

  test("withOTP saves the store", async () => {
    const { env, client, body, users } = setup();
    await users.withOTP("o1", "123456", { mfaId: "m1" });
    expect(env.requests[0]!.url).toBe(`${base}/auth-with-otp`);
    expect(body()).toEqual({ otpId: "o1", password: "123456", mfaId: "m1" });
    expect(client.authStore.token).toBe(token);
  });

  test("withOAuth2Code saves the store", async () => {
    const { env, client, body, users } = setup();
    await users.withOAuth2Code("google", "code", "verifier", "http://r", {
      name: "x",
    });
    expect(env.requests[0]!.url).toBe(`${base}/auth-with-oauth2`);
    expect(body()).toEqual({
      provider: "google",
      code: "code",
      codeVerifier: "verifier",
      redirectURL: "http://r",
      createData: { name: "x" },
    });
    expect(client.authStore.record).toEqual(user);
  });

  test("refresh saves the store", async () => {
    const { env, client, users } = setup();
    client.authStore.save("old", user);
    await users.refresh({ expand: { team: true } });
    expect(env.requests[0]!.method).toBe("POST");
    expect(env.requests[0]!.url).toBe(`${base}/auth-refresh?expand=team`);
    expect(env.requests[0]!.headers.get("Authorization")).toBe("old");
    expect(client.authStore.token).toBe(token);
  });

  test("impersonate returns a separate client and leaves the caller's store", async () => {
    const { env, client, body } = setup();
    client.authStore.save("super", { ...user, collectionName: "_superusers" });
    const other = await client.auth("users").impersonate("u 1", 60);
    expect(env.requests[0]!.url).toBe(`${base}/impersonate/u%201`);
    expect(env.requests[0]!.headers.get("Authorization")).toBe("super");
    expect(body()).toEqual({ duration: 60 });
    expect(other).not.toBe(client);
    expect(other.url).toBe("http://a");
    expect(other.authStore.token).toBe(token);
    expect(other.authStore.record).toEqual(user);
    expect(client.authStore.token).toBe("super");

    await other.records("posts").findOne("p1");
    expect(env.requests[1]!.headers.get("Authorization")).toBe(token);
  });

  test("impersonate keeps a caller Authorization in any case", async () => {
    const { env, client } = setup();
    client.authStore.save("super", user);
    await client
      .auth("users")
      .impersonate("u1", 60, { headers: { authorization: "mine" } });
    expect(env.requests[0]!.headers.get("Authorization")).toBe("mine");
  });

  test("requestVerification", async () => {
    const { env, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    expect(await users.requestVerification("a@b.c")).toBeUndefined();
    expect(env.requests[0]!.url).toBe(`${base}/request-verification`);
    expect(body()).toEqual({ email: "a@b.c" });
  });

  test("confirmVerification marks the stored record verified only for the same record", async () => {
    const { env, client, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    client.authStore.save(token, { ...user, verified: false });

    await users.confirmVerification(jwt({ id: "u2", collectionId: "c1" }));
    expect(client.authStore.record?.verified).toBe(false);
    await users.confirmVerification(jwt({ id: "u1", collectionId: "c2" }));
    expect(client.authStore.record?.verified).toBe(false);

    const t = jwt({ id: "u1", collectionId: "c1" });
    await users.confirmVerification(t);
    expect(env.requests[2]!.url).toBe(`${base}/confirm-verification`);
    expect(body(2)).toEqual({ token: t });
    expect(client.authStore.record?.verified).toBe(true);
    expect(client.authStore.token).toBe(token);
  });

  test("requestPasswordReset", async () => {
    const { env, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    await users.requestPasswordReset("a@b.c");
    expect(env.requests[0]!.url).toBe(`${base}/request-password-reset`);
    expect(body()).toEqual({ email: "a@b.c" });
  });

  test("confirmPasswordReset", async () => {
    const { env, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    await users.confirmPasswordReset("t", "p1", "p2");
    expect(env.requests[0]!.url).toBe(`${base}/confirm-password-reset`);
    expect(body()).toEqual({
      token: "t",
      password: "p1",
      passwordConfirm: "p2",
    });
  });

  test("requestEmailChange", async () => {
    const { env, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    await users.requestEmailChange("new@b.c");
    expect(env.requests[0]!.url).toBe(`${base}/request-email-change`);
    expect(body()).toEqual({ newEmail: "new@b.c" });
  });

  test("confirmEmailChange clears the store for the same record", async () => {
    const { env, client, body, users } = setup();
    env.respond(() => new Response(null, { status: 204 }));
    client.authStore.save(token, user);

    await users.confirmEmailChange(jwt({ id: "u2", collectionId: "c1" }), "pw");
    expect(client.authStore.token).toBe(token);

    const t = jwt({ id: "u1", collectionId: "c1" });
    await users.confirmEmailChange(t, "pw");
    expect(env.requests[1]!.url).toBe(`${base}/confirm-email-change`);
    expect(body(1)).toEqual({ token: t, password: "pw" });
    expect(client.authStore.token).toBe("");
    expect(client.authStore.record).toBeNull();
  });
});
