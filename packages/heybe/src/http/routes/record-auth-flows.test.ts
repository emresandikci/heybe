import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "../../app";
import { newMailToken } from "../../auth/tokens";
import type { MailMessage } from "../../mail/mailer";
import { errorResponse } from "../errors";
import { createEvent } from "../router";
import { loadAuth } from "../middlewares";
import { createRouter } from "../server";
import { internalRecords } from "../../records/internal";

let app: App;
let clock: Date;
let sent: MailMessage[];

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  app = createApp({ dir: ":memory:", now: () => clock });
  sent = [];
  app.mailer = { send: async (msg) => void sent.push(msg) };
});

afterEach(() => app.close());

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function post(path: string, body: unknown): Promise<Response> {
  const req = new Request(`http://x/api/collections/users/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const found = createRouter().match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params);
  e.auth = loadAuth(app, req);
  try {
    return await found.h(e);
  } catch (err) {
    return errorResponse(err);
  }
}

const createUser = (email: string) =>
  app.records("users").create({ email, password: "12345678" });

const users = () => app.collections.find("users")!;

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

describe("request routes do not wait for the mail", () => {
  const routes = [
    ["request-verification", 204],
    ["request-password-reset", 204],
    ["request-otp", 200],
  ] as const;
  for (const [path, status] of routes)
    test(`${path} answers known and unknown emails while the mailer hangs`, async () => {
      await app.collections.save({
        id: users().id,
        otp: { ...(users().otp as object), enabled: true },
      } as any);
      await createUser("known@example.com");
      let calls = 0;
      app.mailer = { send: () => (calls++, new Promise<void>(() => {})) };

      const unknown = await post(path, { email: "nobody@example.com" });
      expect(unknown.status).toBe(status);
      await tick();
      expect(calls).toBe(0);

      const known = await post(path, { email: "known@example.com" });
      expect(known.status).toBe(status);
      if (status === 200)
        expect(typeof ((await known.json()) as any).otpId).toBe("string");
      expect(calls).toBe(0);
      await tick();
      expect(calls).toBe(1);
    });
});

describe("expired tokens", () => {
  const cases = [
    ["verification", "verificationToken", "confirm-verification", {}],
    [
      "passwordReset",
      "passwordResetToken",
      "confirm-password-reset",
      { password: "newpass123", passwordConfirm: "newpass123" },
    ],
    [
      "emailChange",
      "emailChangeToken",
      "confirm-email-change",
      { password: "12345678" },
    ],
  ] as const;

  for (const [kind, config, path, extra] of cases)
    test(`${kind} works until its duration ends`, async () => {
      const record = await createUser("exp@example.com");
      const raw = internalRecords(app, "users").findRaw(record.id as string);
      const token = newMailToken(app, kind, users(), raw, "new@example.com");
      const { duration } = users()[config] as { duration: number };

      advance(duration);
      const expired = await post(path, { token, ...extra });
      expect(expired.status).toBe(400);
      expect(((await expired.json()) as any).data.token.code).toBe(
        "validation_invalid_token",
      );

      clock = new Date(clock.getTime() - 1000);
      expect((await post(path, { token, ...extra })).status).toBe(204);
    });
});

describe("single-use tokens", () => {
  const cases = [
    [
      "passwordReset",
      "confirm-password-reset",
      { password: "newpass123", passwordConfirm: "newpass123" },
    ],
    ["emailChange", "confirm-email-change", { password: "12345678" }],
  ] as const;

  for (const [kind, path, extra] of cases)
    test(`two parallel ${path} calls with one token: statuses sorted equal [204, 400]`, async () => {
      const record = await createUser("once@example.com");
      const raw = internalRecords(app, "users").findRaw(record.id as string);
      const token = newMailToken(app, kind, users(), raw, "new@example.com");
      const responses = await Promise.all([
        post(path, { token, ...extra }),
        post(path, { token, ...extra }),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([204, 400]);
      const failed = responses.find((r) => r.status === 400)!;
      expect(((await failed.json()) as any).data.token.code).toBe(
        "validation_invalid_token",
      );
    });
});

describe("resend window", () => {
  test("a second verification mail waits 2 minutes", async () => {
    await createUser("again@example.com");
    const request = async () => {
      await post("request-verification", { email: "again@example.com" });
      await tick();
    };
    await request();
    await request();
    expect(sent).toHaveLength(1);
    advance(119);
    await request();
    expect(sent).toHaveLength(1);
    advance(1);
    await request();
    expect(sent).toHaveLength(2);
  });

  test("a failed password reset mail does not start the window", async () => {
    await createUser("again@example.com");
    const request = async () => {
      await post("request-password-reset", { email: "again@example.com" });
      await tick();
    };
    let fail = true;
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...args) => void errors.push(args);
    app.mailer = {
      send: async (msg) => {
        if (fail) throw new Error("down");
        sent.push(msg);
      },
    };
    try {
      await request();
      fail = false;
      await request();
      await request();
    } finally {
      console.error = log;
    }
    expect(errors).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("confirming the verification ends the window", async () => {
    const record = await createUser("again@example.com");
    const id = record.id as string;
    await post("request-verification", { email: "again@example.com" });
    await tick();
    const token = newMailToken(
      app,
      "verification",
      users(),
      internalRecords(app, "users").findRaw(id),
    );
    expect((await post("confirm-verification", { token })).status).toBe(204);
    await app.records("users").update(id, { verified: false });
    await post("request-verification", { email: "again@example.com" });
    await tick();
    expect(sent).toHaveLength(2);
  });
});

describe("verification with password auth disabled", () => {
  test("the random password skips the password field max and pattern", async () => {
    const record = await createUser("nopass@example.com");
    const id = record.id as string;
    await app.collections.save({
      id: users().id,
      passwordAuth: { ...(users().passwordAuth as object), enabled: false },
      fields: users().fields.map((f) =>
        f.name === "password" ? { ...f, max: 20, pattern: "^[a-z]+$" } : f,
      ),
    } as any);
    const token = newMailToken(
      app,
      "verification",
      users(),
      internalRecords(app, "users").findRaw(id),
    );
    expect((await post("confirm-verification", { token })).status).toBe(204);
    const raw = internalRecords(app, "users").findRaw(id);
    expect(raw.verified).toBe(true);
    expect(
      await Bun.password.verify("12345678", (raw.password as any).hash),
    ).toBe(false);
  });
});
