import type { App } from "../app";
import { findSingleColumnUniqueIndex, quote } from "../collections/ddl";
import type { Collection } from "../collections/model";
import { type RecordMailKind, renderRecordMail } from "../mail/templates";
import { newMailToken } from "./tokens";

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
  return row ? app.records(c.name).findRaw(row.id) : null;
}

type MailFlow = "verification" | "passwordReset" | "emailChange";

const TEMPLATES: Record<MailFlow, RecordMailKind> = {
  verification: "verification",
  passwordReset: "resetPassword",
  emailChange: "confirmEmailChange",
};

// PB mails.SendRecordVerification, SendRecordPasswordReset and SendRecordChangeEmail.
export async function sendFlowMail(
  app: App,
  flow: MailFlow,
  c: Collection,
  record: Values,
  newEmail?: string,
): Promise<void> {
  const token = newMailToken(app, flow, c, record, newEmail);
  const mail = renderRecordMail(app, TEMPLATES[flow], c, record, {
    "{TOKEN}": token,
  });
  const { meta } = app.settings.get();
  await app.mailer.send({
    from: { name: meta.senderName, address: meta.senderAddress },
    to: [{ address: newEmail ?? (record.email as string) }],
    ...mail,
  });
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
