import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "../../app";
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
const setMfa = async (mfa: object) =>
  await app.collections.save({
    id: users().id,
    otp: { ...(users().otp as object), enabled: true },
    mfa: { ...(users().mfa as object), enabled: true, ...mfa },
  } as any);

beforeEach(async () => {
  clock = new Date("2026-01-01T00:00:00Z");
  app = createApp({ dir: ":memory:", now: () => clock });
  sent = [];
  app.mailer = { send: async (msg) => void sent.push(msg) };
  await setMfa({});
});

afterEach(() => app.close());

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

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
  e.remoteIp = "9.9.9.9";
  try {
    return await found.h(e);
  } catch (err) {
    return errorResponse(err);
  }
}

const createUser = () =>
  app.records("users").create({ email: "a@example.com", password: "12345678" });

const withPassword = (extra = {}) =>
  post("auth-with-password", {
    identity: "a@example.com",
    password: "12345678",
    ...extra,
  });

async function startMfa(): Promise<string> {
  const res = await withPassword();
  expect(res.status).toBe(401);
  return ((await res.json()) as { mfaId: string }).mfaId;
}

async function withOtp(mfaId: string): Promise<Response> {
  const res = await post("request-otp", { email: "a@example.com" });
  const { otpId } = (await res.json()) as { otpId: string };
  await tick();
  const code = /<strong>(\d+)<\/strong>/.exec(sent.at(-1)!.html ?? "")![1]!;
  return post("auth-with-otp", { otpId, password: code, mfaId });
}

const message = async (res: Response) =>
  ((await res.json()) as { message: string }).message;

const mfaCount = () => app.db.query("SELECT id FROM _mfas").length;

describe("mfa", () => {
  test("the second method completes the login and consumes the mfaId", async () => {
    await createUser();
    const mfaId = await startMfa();
    expect(internalRecords(app, "_mfas").findRaw(mfaId).method).toBe(
      "password",
    );
    const res = await withOtp(mfaId);
    expect(res.status).toBe(200);
    expect(mfaCount()).toBe(0);
  });

  test("an mfaId is valid for the MFA duration and then deleted", async () => {
    await createUser();
    await setMfa({ duration: 60 });
    const first = await startMfa();
    advance(60);
    expect((await withOtp(first)).status).toBe(200);

    const second = await startMfa();
    advance(61);
    const res = await withOtp(second);
    expect(res.status).toBe(400);
    expect(await message(res)).toBe("Invalid or expired MFA session.");
    expect(mfaCount()).toBe(0);
  });

  test("the same method again is rejected", async () => {
    await createUser();
    const mfaId = await startMfa();
    const res = await withPassword({ mfaId });
    expect(res.status).toBe(400);
    expect(await message(res)).toBe(
      "A different authentication method is required.",
    );
    expect(mfaCount()).toBe(1);
  });

  test("a non-string mfaId is a 400", async () => {
    await createUser();
    const res = await withPassword({ mfaId: 1 });
    expect(res.status).toBe(400);
    expect(await message(res)).toBe("Failed to read MFA Id.");
  });

  test("a password change drops the record's MFAs", async () => {
    const user = await createUser();
    await startMfa();
    await app
      .records("users")
      .update(user.id as string, { password: "87654321" });
    expect(mfaCount()).toBe(0);
  });

  test("starting an MFA deletes the collection's expired ones", async () => {
    await createUser();
    await startMfa();
    advance(601);
    await startMfa();
    expect(mfaCount()).toBe(1);
  });

  test("auth-methods reports the mfa config", async () => {
    const req = new Request("http://x/api/collections/users/auth-methods");
    const found = createRouter().match("GET", new URL(req.url).pathname)!;
    const res = await found.h(createEvent(app, req, found.params));
    expect(((await res.json()) as any).mfa).toEqual({
      enabled: true,
      duration: 600,
    });
  });
});
