import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App } from "../../app";
import { testApp } from "../../test-app";
import type { MailMessage } from "../../mail/mailer";
import { errorResponse } from "../errors";
import { createEvent } from "../router";
import { loadAuth } from "../middlewares";
import { createRouter } from "../server";
import { internalRecords } from "../../records/internal";

let app: App;
let clock: Date;
let sent: MailMessage[];

const users = () => app.collections.find("users")!;
const setOtp = async (enabled: boolean) =>
  await app.collections.save({
    id: users().id,
    otp: { ...(users().otp as object), enabled },
  } as any);

beforeEach(async () => {
  clock = new Date("2026-01-01T00:00:00Z");
  app = testApp({ now: () => clock });
  sent = [];
  app.mailer = { send: async (msg) => void sent.push(msg) };
  await setOtp(true);
});

afterEach(() => app.close());

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function post(
  path: string,
  body: unknown,
  collection = "users",
  headers: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`http://x/api/collections/${collection}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const found = createRouter()
    .build()
    .match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  e.remoteIp = "9.9.9.9";
  try {
    return await found.run(e);
  } catch (err) {
    return e.response ?? errorResponse(err);
  }
}

const createUser = (email: string, extra = {}) =>
  app.records("users").create({ email, password: "12345678", ...extra });

async function requestCode(
  email: string,
): Promise<{ otpId: string; code: string }> {
  const res = await post("request-otp", { email });
  const { otpId } = (await res.json()) as { otpId: string };
  await tick();
  const code = /<strong>(\d+)<\/strong>/.exec(sent.at(-1)!.html ?? "")![1]!;
  return { otpId, code };
}

describe("request-otp", () => {
  test("mails the code of the returned otpId to a known email", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    expect(code).toHaveLength(8);
    expect(sent).toHaveLength(1);
    expect(internalRecords(app, "_otps").findRaw(otpId).recordRef).toBeTruthy();
  });

  test("an unknown email gets a 200 with an id and no mail or row", async () => {
    const res = await post("request-otp", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { otpId: string }).otpId).toHaveLength(15);
    await tick();
    expect(sent).toHaveLength(0);
    expect(app.db.query("SELECT id FROM _otps")).toHaveLength(0);
  });

  test("a disabled collection answers 403", async () => {
    await setOtp(false);
    expect((await post("request-otp", { email: "a@example.com" })).status).toBe(
      403,
    );
    expect((await post("auth-with-otp", {})).status).toBe(403);
  });

  test("a failed mail deletes the OTP", async () => {
    await createUser("a@example.com");
    app.mailer = {
      send: async () => {
        throw new Error("down");
      },
    };
    await post("request-otp", { email: "a@example.com" });
    await tick();
    expect(app.db.query("SELECT id FROM _otps")).toHaveLength(0);
  });
});

describe("auth-with-otp", () => {
  test("logs in with the code once", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    const ok = await post("auth-with-otp", { otpId, password: code });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).record.email).toBe("a@example.com");
    const again = await post("auth-with-otp", { otpId, password: code });
    expect(again.status).toBe(400);
    expect(((await again.json()) as any).message).toBe(
      "Invalid or expired OTP.",
    );
  });

  test("a wrong code fails and leaves the OTP usable", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    const wrong = code === "00000000" ? "11111111" : "00000000";
    expect(
      (await post("auth-with-otp", { otpId, password: wrong })).status,
    ).toBe(400);
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(200);
  });

  test("the 6th attempt in a window is rate limited even with the right code", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    for (let i = 0; i < 5; i++)
      await post("auth-with-otp", { otpId, password: "x" });
    const limited = await post("auth-with-otp", { otpId, password: code });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { message: string }).message).toBe(
      "Too many attempts, please try again later with a new OTP.",
    );
    advance(180);
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(200);
  });

  test("an expired code fails", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    advance(181);
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(400);
  });

  test("an otpId of another collection fails", async () => {
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    await app.collections.save({
      name: "members",
      type: "auth",
      otp: { ...(users().otp as object), enabled: true },
    } as any);
    expect(
      (await post("auth-with-otp", { otpId, password: code }, "members"))
        .status,
    ).toBe(400);
  });

  test("a password change kills pending OTPs", async () => {
    const user = await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    await app
      .records("users")
      .update(user.id as string, { password: "newpass123" });
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(400);
  });

  test("validation errors", async () => {
    const res = await post("auth-with-otp", {});
    expect(res.status).toBe(400);
    const { data } = (await res.json()) as any;
    expect(Object.keys(data)).toEqual(["otpId", "password"]);
  });

  test("an OTP mailed to the record email verifies it and replaces the password", async () => {
    const user = await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    expect(internalRecords(app, "_otps").findRaw(otpId).sentTo).toBe(
      "a@example.com",
    );
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(200);
    expect(
      internalRecords(app, "users").findRaw(user.id as string).verified,
    ).toBe(true);
    const login = await post("auth-with-password", {
      identity: "a@example.com",
      password: "12345678",
    });
    expect(login.status).toBe(400);
  });
});

const constrainPassword = async () =>
  await app.collections.save({
    id: users().id,
    fields: users().fields.map((f) =>
      f.name === "password" ? { ...f, max: 20, pattern: "^[a-z]+$" } : f,
    ),
  } as any);

describe("random password after OTP verification", () => {
  test("ignores the password field max and pattern", async () => {
    const user = await createUser("a@example.com");
    await constrainPassword();
    const { otpId, code } = await requestCode("a@example.com");
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(200);
    const raw = internalRecords(app, "users").findRaw(user.id as string);
    expect(raw.verified).toBe(true);
    const login = await post("auth-with-password", {
      identity: "a@example.com",
      password: "12345678",
    });
    expect(login.status).toBe(400);
  });
});

describe("attempt limit behind a trusted proxy", () => {
  test("clients are counted by their forwarded ip", async () => {
    await app.settings.update({
      trustedProxy: { headers: ["x-forwarded-for"] },
    });
    await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    const as = (ip: string, password: string) =>
      post("auth-with-otp", { otpId, password }, "users", {
        "x-forwarded-for": ip,
      });
    for (let i = 0; i < 5; i++) await as("1.1.1.1", "x");
    expect((await as("1.1.1.1", code)).status).toBe(429);
    expect((await as("2.2.2.2", code)).status).toBe(200);
  });
});

describe("tokenKey change", () => {
  test("an explicit tokenKey drops pending OTPs", async () => {
    const user = await createUser("a@example.com");
    const { otpId, code } = await requestCode("a@example.com");
    await app.records("users").update(user.id as string, {
      tokenKey: "k".repeat(50),
    });
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(400);
  });
});

describe("auth-methods", () => {
  test("reflects the otp config", async () => {
    const req = new Request("http://x/api/collections/users/auth-methods");
    const found = createRouter()
      .build()
      .match("GET", "/api/collections/users/auth-methods")!;
    const res = await found.run(createEvent(app, req, found.params));
    expect(((await res.json()) as any).otp).toEqual({
      enabled: true,
      duration: 180,
    });
  });
});

describe("otp request hooks", () => {
  test("onRecordRequestOTPRequest may set the code and onRecordAuthWithOTPRequest sees the OTP", async () => {
    await createUser("a@example.com");
    app.onRecordRequestOTPRequest((e) => {
      e.password = "11112222";
      return e.next();
    });
    const seen: unknown[] = [];
    app.onRecordAuthWithOTPRequest(async (e) => {
      seen.push(e.otp.id, e.record.get("email"));
      await e.next();
      seen.push(e.response?.status);
    });
    const { otpId, code } = await requestCode("a@example.com");
    expect(code).toBe("11112222");
    const res = await post("auth-with-otp", { otpId, password: "11112222" });
    expect(res.status).toBe(200);
    expect(seen).toEqual([otpId, "a@example.com", 200]);
  });

  test("an unknown email fails next() after the dummy 200", async () => {
    let failed = false;
    app.onRecordRequestOTPRequest(async (e) => {
      try {
        await e.next();
      } catch (err) {
        failed = true;
        throw err;
      }
    });
    const res = await post("request-otp", { email: "nobody@example.com" });
    expect(res.status).toBe(200);
    expect(failed).toBe(true);
  });

  test("the used OTP goes through the hooked delete", async () => {
    await createUser("a@example.com");
    const deleted: string[] = [];
    app.onRecordDelete("_otps", (e) => {
      deleted.push(e.record.id);
      return e.next();
    });
    const { otpId, code } = await requestCode("a@example.com");
    expect(
      (await post("auth-with-otp", { otpId, password: code })).status,
    ).toBe(200);
    expect(deleted).toEqual([otpId]);
  });
});
