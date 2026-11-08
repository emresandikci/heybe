import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { App } from "../app";
import { MailerEvent, MailerRecordEvent } from "../hooks/events";
import type { Hook } from "../hooks/hook";
import type { RecordModel } from "../records/model";
import type { SettingsData } from "../settings";

export interface MailMessage {
  from: { name: string; address: string };
  to: { name?: string; address: string }[];
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

const SENDMAIL_PATHS = ["/usr/sbin/sendmail", "/usr/bin/sendmail", "sendmail"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// A leading "-" would be read as an option by the sendmail binary.
function assertRecipients(msg: MailMessage): void {
  for (const { address } of [...msg.to, msg.from])
    if (address.startsWith("-"))
      throw new Error(`invalid mail address ${JSON.stringify(address)}`);
}

function toOptions(msg: MailMessage) {
  assertRecipients(msg);
  const headers = { ...msg.headers };
  const domain = msg.from.address.split("@");
  const hasMessageId = Object.keys(headers).some(
    (k) => k.toLowerCase() === "message-id",
  );
  if (!hasMessageId && domain.length === 2)
    headers["Message-ID"] =
      `<${randomBytes(11).toString("base64url")}@${domain[1]}>`;
  return {
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    html: msg.html || undefined,
    text: msg.text,
    headers,
  };
}

export function smtpTransportOptions(smtp: SettingsData["smtp"]) {
  const hasAuth = smtp.username !== "" || smtp.password !== "";
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls,
    name: smtp.localName || "localhost",
    // like PB, never send credentials unencrypted to a remote host
    requireTLS: hasAuth && !smtp.tls && !LOCAL_HOSTS.has(smtp.host),
    auth: hasAuth
      ? {
          user: smtp.username,
          pass: smtp.password,
          method: smtp.authMethod === "LOGIN" ? "LOGIN" : "PLAIN",
        }
      : undefined,
  };
}

function smtpMailer(smtp: SettingsData["smtp"]): Mailer {
  return {
    async send(msg) {
      const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
      try {
        await transport.sendMail(toOptions(msg));
      } finally {
        transport.close();
      }
    },
  };
}

const sendmailMailer: Mailer = {
  async send(msg) {
    assertRecipients(msg);
    const path = SENDMAIL_PATHS.map((p) => Bun.which(p)).find(Boolean);
    if (!path) throw new Error("failed to locate a sendmail executable path");
    const transport = nodemailer.createTransport({
      sendmail: true,
      newline: "unix",
      path,
    });
    await transport.sendMail(toOptions(msg));
  },
};

export function mailerFromSettings(settings: SettingsData): Mailer {
  return settings.smtp.enabled ? smtpMailer(settings.smtp) : sendmailMailer;
}

// PB NewMailClient with its __pbMailerOnSend__ handler: every send goes through onMailerSend, whose
// handlers may replace the message or skip the send.
export function appMailer(app: App): Mailer {
  return {
    send(message) {
      const client = mailerFromSettings(app.settings.get());
      const hook = app.hooks.onMailerSend;
      if (hook.length === 0) return client.send(message);
      return hook.trigger(
        MailerEvent.of({ app, mailer: client, message }),
        (e) => client.send(e.message),
      );
    },
  };
}

// PB mails/record.go: `hook` (an onMailerRecord*Send) around `send`, by default the app mailer send.
export function sendRecordMail(
  app: App,
  hook: Hook<MailerRecordEvent>,
  record: RecordModel,
  message: MailMessage,
  meta: Record<string, unknown>,
  send = (mailer: Mailer, message: MailMessage) => mailer.send(message),
): Promise<void> {
  if (hook.length === 0) return send(app.mailer, message);
  return hook.trigger(
    MailerRecordEvent.of({ app, mailer: app.mailer, message, record, meta }),
    (e) => send(e.mailer, e.message),
  );
}
