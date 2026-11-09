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

// Go textproto.CanonicalMIMEHeaderKey
const canonicalKey = (key: string) =>
  key
    .toLowerCase()
    .replace(
      /(^|-)([a-z])/g,
      (_, dash: string, c: string) => dash + c.toUpperCase(),
    );

// Go's Header.Write skips keys that are not RFC 7230 tokens
const VALID_HEADER_KEY = /^[!#-'*+\-.^_`|~0-9A-Za-z]+$/;

const MAX_CONTENT_LEN = 63;
const MAX_BASE64_BYTES = 45;
const HEX = "0123456789ABCDEF";

// Go mime.QEncoding.Encode("utf-8", s)
function qEncode(s: string): string {
  if (!/[^\t\x20-\x7e]/.test(s)) return s;
  const words: string[] = [];
  let word = "";
  let len = 0;
  for (const char of s) {
    const plain = char >= " " && char <= "~" && !"=?_".includes(char);
    const bytes = Buffer.from(char);
    const encLen = plain ? 1 : 3 * bytes.length;
    if (len + encLen > MAX_CONTENT_LEN) {
      words.push(word);
      word = "";
      len = 0;
    }
    word +=
      char === " "
        ? "_"
        : plain
          ? char
          : [...bytes].map((b) => `=${HEX[b >> 4]}${HEX[b & 15]}`).join("");
    len += encLen;
  }
  words.push(word);
  return words.map((w) => `=?utf-8?q?${w}?=`).join(" ");
}

// Go mime.BEncoding.Encode("utf-8", s)
function bEncode(s: string): string {
  if (!/[^\t\x20-\x7e]/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const char of s) {
    if (Buffer.byteLength(chunk + char) > MAX_BASE64_BYTES) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  words.push(chunk);
  return words
    .map((w) => `=?utf-8?b?${Buffer.from(w).toString("base64")}?=`)
    .join(" ");
}

// Go mail.Address.String()
function formatAddress({ name, address }: { name?: string; address: string }) {
  const addr = `<${address}>`;
  if (!name) return addr;
  if (!/[^\t\x20-\x7e]/.test(name))
    return `"${name.replace(/(["\\])/g, "\\$1")}" ${addr}`;
  return `${/["#$%&'(),.:;<>@[\]^`{|}~]/.test(name) ? bEncode(name) : qEncode(name)} ${addr}`;
}

const addresses = (list: { address: string }[]) =>
  list.map((a) => a.address).join(",");

// PB tools/mailer/sendmail.go send(): header block sorted by key like Go's http.Header.Write
export function sendmailMessage(msg: MailMessage): string {
  const headers = new Map<string, string>();
  const set = (key: string, value: string) =>
    headers.set(canonicalKey(key), value);
  set("Subject", qEncode(msg.subject));
  set("From", formatAddress(msg.from));
  set("To", addresses(msg.to));
  set("Content-Type", `text/${msg.html ? "html" : "plain"}; charset=UTF-8`);
  for (const [k, v] of Object.entries(msg.headers ?? {}))
    if (VALID_HEADER_KEY.test(k)) set(k, v);
  if (!headers.get("Message-Id")) {
    const parts = msg.from.address.split("@");
    if (parts.length === 2)
      set(
        "Message-ID",
        `<${randomBytes(11).toString("base64url")}@${parts[1]}>`,
      );
  }
  const block = [...headers]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}: ${v.replace(/[\r\n]/g, " ").trim()}\r\n`)
    .join("");
  return `${block}\r\n${msg.html || msg.text}`;
}

export const sendmailMailer = (paths = SENDMAIL_PATHS): Mailer => ({
  async send(msg) {
    assertRecipients(msg);
    const path = paths.map((p) => Bun.which(p)).find(Boolean);
    if (!path) throw new Error("failed to locate a sendmail executable path");
    const proc = Bun.spawn([path, "-i", "-t"], {
      stdin: new Blob([sendmailMessage(msg)]),
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`exit status ${code}`);
  },
});

export function mailerFromSettings(settings: SettingsData): Mailer {
  return settings.smtp.enabled ? smtpMailer(settings.smtp) : sendmailMailer();
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
