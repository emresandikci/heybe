import type { App } from "../app";
import type { Collection } from "../collections/model";
import { NotFoundError, formatDate, randomString } from "../util";
import { internalRecords } from "../records/internal";
import { RecordModel } from "../records/model";

type Values = Record<string, unknown>;

const DIGITS = "0123456789";
// PB creates a new OTP per request but reuses the latest one after this many unexpired ones
const MAX_RECENT = 9;

const otpOptions = (c: Collection) =>
  c.otp as { enabled: boolean; duration: number; length: number };

export const otpDurationMs = (c: Collection) => otpOptions(c).duration * 1000;

export const otpLength = (c: Collection) => otpOptions(c).length;

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
  code = generateOtpCode(otpLength(c)),
): Promise<{ id: string; code: string | null }> {
  const existing = findRecordOtps(app, c, record);
  let recent = 0;
  for (const otp of existing) {
    if (!hasExpired(app, otp, otpDurationMs(c))) recent++;
    if (recent > MAX_RECENT)
      return { id: existing[0]!.id as string, code: null };
  }
  const created = await internalRecords(app, "_otps").create({
    collectionRef: c.id,
    recordRef: record.id,
    password: code,
  });
  return { id: created.id as string, code };
}

// The hooked delete; false when another request already used it (writes are serialized), which keeps
// the code single use under concurrency.
export function deleteOtp(app: App, id: string): Promise<boolean> {
  return app.db.write(async () => {
    const otp = findOtp(app, id);
    if (!otp) return false;
    const c = app.collections.find("_otps")!;
    await internalRecords(app, c.name).deleteRecord(
      new RecordModel(c, otp, false),
    );
    return true;
  });
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
