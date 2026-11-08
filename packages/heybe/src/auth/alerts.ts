import type { App } from "../app";
import type { Collection } from "../collections/model";
import { escapeHtml, renderRecordMail } from "../mail/templates";
import { formatDate } from "../util";

type Values = Record<string, unknown>;

const MAX_AUTH_ORIGINS = 5;
const SEND_TIMEOUT_MS = 15_000;

async function sendAuthAlert(
  app: App,
  c: Collection,
  record: Values,
  info: string,
): Promise<void> {
  const mail = renderRecordMail(app, "authAlert", c, record, {
    "{ALERT_INFO}": escapeHtml(info),
  });
  const { meta } = app.settings.get();
  await app.mailer.send({
    from: { name: meta.senderName, address: meta.senderAddress },
    to: [{ address: record.email as string }],
    ...mail,
  });
}

// Port of PB authAlert: remembers the ip and user agent of a login and mails the record about a new
// one, except for its first. Like PB a failed or timed out send keeps the origin unsaved so the next login retries.
export async function recordAuthOrigin(
  app: App,
  c: Collection,
  record: Values,
  ip: string,
  userAgent: string,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<void> {
  const agent =
    userAgent.length > 200 ? `${userAgent.slice(0, 200)}...` : userAgent;
  const fingerprint = new Bun.CryptoHasher("md5")
    .update(ip + agent)
    .digest("hex");
  const info = `${formatDate(app.now())} - ${ip} ${agent}`;

  const origins = app.db.query<{ id: string; fingerprint: string }>(
    "SELECT id, fingerprint FROM _authOrigins WHERE collectionRef = ? AND recordRef = ? ORDER BY created DESC",
    [c.id, record.id as string],
  );
  const current = origins.find((o) => o.fingerprint === fingerprint);
  if (current) {
    await app.records("_authOrigins").update(current.id, { fingerprint });
    return;
  }

  if (origins.length > 0 && record.email) {
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("auth alert mail send wait timeout reached")),
        timeoutMs,
      );
    });
    try {
      await Promise.race([sendAuthAlert(app, c, record, info), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  await app.db.write(() => {
    for (const old of origins.slice(MAX_AUTH_ORIGINS - 1))
      app.db.run("DELETE FROM _authOrigins WHERE id = ?", [old.id]);
  });
  await app.records("_authOrigins").create({
    collectionRef: c.id,
    recordRef: record.id,
    fingerprint,
  });
}
