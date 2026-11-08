import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type App, createApp } from "../app";
import {
  consumeOtpAttempt,
  deleteExpiredOtps,
  generateOtpCode,
  hasExpired,
  issueOtp,
} from "./otp";

let app: App;
let clock: Date;

beforeEach(() => {
  clock = new Date("2026-01-01T00:00:00Z");
  app = createApp({ dir: ":memory:", now: () => clock });
});

afterEach(() => app.close());

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

const users = () => app.collections.find("users")!;

describe("generateOtpCode", () => {
  test("has the requested length and only digits", () => {
    for (const length of [4, 8, 71]) {
      const code = generateOtpCode(length);
      expect(code).toHaveLength(length);
      expect(code).toMatch(/^[0-9]+$/);
    }
  });

  test("uses every digit and does not repeat", () => {
    const seen = new Set<string>();
    for (const digit of generateOtpCode(2000)) seen.add(digit);
    expect(seen.size).toBe(10);
    expect(generateOtpCode(20)).not.toBe(generateOtpCode(20));
  });
});

describe("expiry", () => {
  test("an OTP lives for its duration and not a moment longer", async () => {
    const record = await app.records("users").create({
      email: "a@example.com",
      password: "12345678",
    });
    const raw = app.records("users").findRaw(record.id as string);
    const { id } = await issueOtp(app, users(), raw);
    const otp = app.records("_otps").findRaw(id);
    advance(180);
    expect(hasExpired(app, otp, 180_000)).toBe(false);
    advance(1);
    expect(hasExpired(app, otp, 180_000)).toBe(true);
  });

  test("the stored code is hashed", async () => {
    const record = await app.records("users").create({
      email: "a@example.com",
      password: "12345678",
    });
    const raw = app.records("users").findRaw(record.id as string);
    const { id, code } = await issueOtp(app, users(), raw);
    const stored = app.records("_otps").findRaw(id).password as {
      hash: string;
    };
    expect(stored.hash).not.toContain(code!);
    expect(await Bun.password.verify(code!, stored.hash)).toBe(true);
  });

  test("deleteExpiredOtps keeps only the unexpired ones of the collection", async () => {
    const record = await app.records("users").create({
      email: "a@example.com",
      password: "12345678",
    });
    const raw = app.records("users").findRaw(record.id as string);
    const old = await issueOtp(app, users(), raw);
    advance(181);
    const fresh = await issueOtp(app, users(), raw);
    await deleteExpiredOtps(app, users());
    const left = app.db.query<{ id: string }>("SELECT id FROM _otps");
    expect(left.map((r) => r.id)).toEqual([fresh.id]);
    expect(left.map((r) => r.id)).not.toContain(old.id);
  });
});

describe("issueOtp", () => {
  test("after 10 unexpired OTPs the latest one is reused without a code", async () => {
    const record = await app.records("users").create({
      email: "a@example.com",
      password: "12345678",
    });
    const raw = app.records("users").findRaw(record.id as string);
    let last = "";
    for (let i = 0; i < 10; i++) {
      advance(1);
      last = (await issueOtp(app, users(), raw)).id;
    }
    advance(1);
    const reused = await issueOtp(app, users(), raw);
    expect(reused).toEqual({ id: last, code: null });
    expect(app.db.query("SELECT id FROM _otps")).toHaveLength(10);
  });
});

describe("consumeOtpAttempt", () => {
  const record = { id: "rec" };

  test("allows 5 attempts per 180 seconds per record and ip", () => {
    for (let i = 0; i < 5; i++)
      expect(consumeOtpAttempt(app, record, "1.1.1.1")).toBe(true);
    expect(consumeOtpAttempt(app, record, "1.1.1.1")).toBe(false);
    expect(consumeOtpAttempt(app, record, "2.2.2.2")).toBe(true);
    expect(consumeOtpAttempt(app, { id: "other" }, "1.1.1.1")).toBe(true);
    advance(179);
    expect(consumeOtpAttempt(app, record, "1.1.1.1")).toBe(false);
    advance(1);
    expect(consumeOtpAttempt(app, record, "1.1.1.1")).toBe(true);
  });

  test("an empty ip is not limited, as in PB", () => {
    for (let i = 0; i < 20; i++)
      expect(consumeOtpAttempt(app, record, "")).toBe(true);
  });
});
