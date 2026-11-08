import type { App } from "../app";
import { findSingleColumnUniqueIndex, quote } from "../collections/ddl";
import type { Collection } from "../collections/model";
import { sendRecordMail } from "../mail/mailer";
import { type RecordMailKind, recordMessage } from "../mail/templates";
import type { RecordModel } from "../records/model";
import { valuesOf } from "../records/service";
import { PasswordValue } from "../fields";
import { randomSecret } from "../util";
import { findOtp } from "./otp";
import { newMailToken } from "./tokens";
import { internalRecords } from "../records/internal";

type Values = Record<string, unknown>;

// PB FindAuthRecordByEmail: case-insensitive only when the email unique index is COLLATE NOCASE.
export function findAuthRecordByEmail(
  app: App,
  c: Collection,
  email: string,
): Values | null {
  const index = findSingleColumnUniqueIndex(c.indexes, "email");
  const nocase = index !== null && /collate\s+nocase/i.test(index.columnsSql);
  const row = app.db.get<{ id: string }>(
    `SELECT id FROM ${quote(c.name)} WHERE "email" = ?${nocase ? " COLLATE NOCASE" : ""} LIMIT 1`,
    [email],
  );
  return row ? internalRecords(app, c.name).findRaw(row.id) : null;
}

type MailFlow = "verification" | "passwordReset" | "emailChange";

const TEMPLATES: Record<MailFlow, RecordMailKind> = {
  verification: "verification",
  passwordReset: "resetPassword",
  emailChange: "confirmEmailChange",
};

const HOOKS = {
  verification: "onMailerRecordVerificationSend",
  passwordReset: "onMailerRecordPasswordResetSend",
  emailChange: "onMailerRecordEmailChangeSend",
} as const;

// PB mails.SendRecordVerification, SendRecordPasswordReset and SendRecordChangeEmail.
export async function sendFlowMail(
  app: App,
  flow: MailFlow,
  record: RecordModel,
  newEmail?: string,
): Promise<void> {
  const c = record.collection;
  const token = newMailToken(app, flow, c, valuesOf(record), newEmail);
  const message = recordMessage(
    app,
    TEMPLATES[flow],
    record,
    { "{TOKEN}": token },
    newEmail ?? String(record.get("email")),
  );
  await sendRecordMail(
    app,
    app.hooks[HOOKS[flow]],
    record,
    message,
    flow === "emailChange" ? { token, newEmail } : { token },
  );
}

// PB mails.SendRecordOTP: the OTP remembers the first address it was sent to.
export async function sendOtpMail(
  app: App,
  record: RecordModel,
  otpId: string,
  code: string,
): Promise<void> {
  const message = recordMessage(
    app,
    "otp",
    record,
    { "{OTP_ID}": otpId, "{OTP}": code },
    String(record.get("email")),
  );
  await sendRecordMail(
    app,
    app.hooks.onMailerRecordOTPSend,
    record,
    message,
    { otpId, password: code },
    async (mailer, message) => {
      await mailer.send(message);
      const to = message.to[0]?.address ?? "";
      // sentTo is what lets a later OTP login mark the email verified
      if (to === "" || findOtp(app, otpId)?.sentTo !== "") return;
      // like PB, a failed update is only logged
      await internalRecords(app, "_otps")
        .update(otpId, { sentTo: to })
        .catch((err) =>
          console.error("heybe: failed to update OTP sentTo:", err),
        );
    },
  );
}

// Like PB routine.FireAndForget: the response does not wait for the mail, so its timing does not
// reveal whether the account exists.
export function inBackground(task: () => Promise<void>): void {
  setImmediate(() => {
    task().catch((err) => console.error("heybe:", err));
  });
}

// PB keeps "@limit..." keys in the app store for 2 minutes after a mail went out.
const RESEND_WINDOW_MS = 2 * 60 * 1000;
const resendUntil = new WeakMap<App, Map<string, number>>();

export const resendLimit = {
  has(app: App, key: string): boolean {
    const keys = resendUntil.get(app);
    const until = keys?.get(key);
    if (until === undefined) return false;
    if (app.now().getTime() < until) return true;
    keys!.delete(key);
    return false;
  },
  set(app: App, key: string): void {
    let keys = resendUntil.get(app);
    if (!keys) resendUntil.set(app, (keys = new Map()));
    keys.set(key, app.now().getTime() + RESEND_WINDOW_MS);
  },
  remove(app: App, key: string): void {
    resendUntil.get(app)?.delete(key);
  },
};

export const verificationResendKey = (c: Collection, record: Values) =>
  `@limitVerificationEmail_${c.id}${record.id}`;

export const passwordResetResendKey = (c: Collection, record: Values) =>
  `@limitPasswordResetEmail_${c.id}${record.id}`;

// PB SetRandomPassword: stored hashed, so the password field's min, max and pattern do not apply.
export async function randomPassword(c: Collection): Promise<PasswordValue> {
  const cost = Number(c.fields.find((f) => f.name === "password")?.cost);
  const hash = await Bun.password.hash(randomSecret(30), {
    algorithm: "bcrypt",
    cost: cost > 0 ? cost : 10,
  });
  return new PasswordValue(hash);
}
