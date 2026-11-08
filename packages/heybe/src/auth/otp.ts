import type { App } from "../app";
import type { Collection } from "../collections/model";
import { NotFoundError, formatDate, randomString } from "../util";
import { internalRecords } from "../records/internal";

type Values = Record<string, unknown>;

const DIGITS = "0123456789";
// PB creates a new OTP per request but reuses the latest one after this many unexpired ones
const MAX_RECENT = 9;
const ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 180 * 1000;
const PRUNE_AT = 10_000;

const otpOptions = (c: Collection) =>
  c.otp as { enabled: boolean; duration: number; length: number };

export const otpDurationMs = (c: Collection) => otpOptions(c).duration * 1000;

export const generateOtpCode = (length: number) => randomString(length, DIGITS);

export function hasExpired(app: App, otp: Values, durationMs: number): boolean {
  const created = Date.parse(String(otp.created).replace(" ", "T"));
  return app.now().getTime() - created > durationMs;
}

export function findOtp(app: App, id: string): Values | null {
  try {
    return internalRecords(app, "_otps").findRaw(id);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

// PB FindAllOTPsByRecord: newest first.
function findRecordOtps(app: App, c: Collection, record: Values): Values[] {
  return app.db
    .query<{ id: string }>(
      "SELECT id FROM _otps WHERE collectionRef = ? AND recordRef = ? ORDER BY created DESC",
      [c.id, record.id as string],
    )
    .map((row) => internalRecords(app, "_otps").findRaw(row.id));
}

// Creates the OTP for a request, or returns the last issued one (without a code, so no mail) when the
// record already has too many unexpired ones.
export async function issueOtp(
  app: App,
  c: Collection,
  record: Values,
): Promise<{ id: string; code: string | null }> {
  const existing = findRecordOtps(app, c, record);
  let recent = 0;
  for (const otp of existing) {
    if (!hasExpired(app, otp, otpDurationMs(c))) recent++;
    if (recent > MAX_RECENT)
      return { id: existing[0]!.id as string, code: null };
  }
  const code = generateOtpCode(otpOptions(c).length);
  const created = await internalRecords(app, "_otps").create({
    collectionRef: c.id,
    recordRef: record.id,
    password: code,
  });
  return { id: created.id as string, code };
}

// False when another request already used it, which keeps the code single use under concurrency.
export async function deleteOtp(app: App, id: string): Promise<boolean> {
  const { changes } = await app.db.write(() =>
    app.db.run("DELETE FROM _otps WHERE id = ?", [id]),
  );
  return changes > 0;
}

export async function deleteExpiredOtps(app: App, c: Collection) {
  const oldest = new Date(app.now().getTime() - otpDurationMs(c));
  await app.db.write(() =>
    app.db.run("DELETE FROM _otps WHERE collectionRef = ? AND created < ?", [
      c.id,
      formatDate(oldest),
    ]),
  );
}

// PB limits OTP guesses per record and client IP, since the codes are short digit strings.
const attempts = new WeakMap<
  App,
  Map<string, { start: number; left: number }>
>();

export function consumeOtpAttempt(
  app: App,
  record: Values,
  ip: string,
): boolean {
  if (ip === "") return true;
  let windows = attempts.get(app);
  if (!windows) attempts.set(app, (windows = new Map()));
  const now = app.now().getTime();
  if (windows.size >= PRUNE_AT)
    for (const [key, w] of windows)
      if (now - w.start >= ATTEMPT_WINDOW_MS) windows.delete(key);
  const key = `${record.id}|${ip}`;
  let w = windows.get(key);
  if (!w || now - w.start >= ATTEMPT_WINDOW_MS) {
    w = { start: now, left: ATTEMPTS };
    windows.set(key, w);
  }
  if (w.left === 0) return false;
  w.left--;
  return true;
}
