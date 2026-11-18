import { type Socket, createServer } from "node:net";

export interface CapturedMail {
  from: string;
  recipients: string[];
  headers: Record<string, string[]>;
  subject: string;
  to: string;
  html: string;
  text: string;
  raw: string;
}

export interface SmtpCapture {
  port: number;
  messages(): CapturedMail[];
  // resolves with the first captured mail to `address`, already received or still to come, or rejects after 2000 ms
  waitFor(address: string): Promise<CapturedMail>;
  // resolves once `count` mails to `address` were captured
  waitForCount(address: string, count: number): Promise<CapturedMail[]>;
  clear(): void;
  stop(): Promise<void>;
}

const WAIT_MS = 2000;

const base64 = (s: string) => Buffer.from(s, "base64").toString();

function decodeQuotedPrintable(input: string): Buffer {
  const text = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(text[i]!));
  }
  return Buffer.from(bytes);
}

function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(
    /=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset: string, enc: string, payload: string) => {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(payload, "base64")
          : decodeQuotedPrintable(payload.replace(/_/g, " "));
      return new TextDecoder(charset).decode(bytes);
    },
  );
}

function splitMessage(raw: string): [string, string] {
  const at = raw.indexOf("\r\n\r\n");
  return at < 0 ? [raw, ""] : [raw.slice(0, at), raw.slice(at + 4)];
}

function parseHeaders(block: string): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (const line of block.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    (headers[name] ??= []).push(line.slice(colon + 1).trim());
  }
  return headers;
}

function parseParts(
  raw: string,
  out: { html: string; text: string },
): Record<string, string[]> {
  const [head, body] = splitMessage(raw);
  const headers = parseHeaders(head);
  const type = headers["content-type"]?.[0] ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (type.toLowerCase().startsWith("multipart/") && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      parseParts(part.replace(/^\r\n/, "").replace(/\r\n$/, ""), out);
    }
    return headers;
  }
  const encoding = headers["content-transfer-encoding"]?.[0]?.toLowerCase();
  const bytes =
    encoding === "base64"
      ? Buffer.from(body, "base64")
      : encoding === "quoted-printable"
        ? decodeQuotedPrintable(body)
        : Buffer.from(body);
  const charset = /charset="?([\w-]+)"?/i.exec(type)?.[1] ?? "utf-8";
  const content = new TextDecoder(charset).decode(bytes);
  const kind = type.toLowerCase();
  if (kind.startsWith("text/html") && out.html === "") out.html = content;
  else if (kind.startsWith("text/plain") && out.text === "") out.text = content;
  return headers;
}

function parseMail(
  from: string,
  recipients: string[],
  raw: string,
): CapturedMail {
  const out = { html: "", text: "" };
  const headers = parseParts(raw, out);
  const first = (name: string) => decodeWords(headers[name]?.[0] ?? "");
  return {
    from,
    recipients,
    headers,
    subject: first("subject"),
    to: first("to"),
    ...out,
    raw,
  };
}

function handleConnection(
  socket: Socket,
  onMail: (m: CapturedMail) => void,
): void {
  let buffer = "";
  let from = "";
  let recipients: string[] = [];
  let receiving = false;
  let login: "user" | "pass" | "plain" | null = null;
  const reply = (line: string) => socket.write(`${line}\r\n`);

  const command = (line: string) => {
    if (login) {
      const step = login;
      login = step === "user" ? "pass" : null;
      if (step === "user") return reply("334 UGFzc3dvcmQ6");
      return reply("235 2.7.0 Authentication successful");
    }
    const [verb = "", ...rest] = line.split(" ");
    switch (verb.toUpperCase()) {
      case "EHLO":
        return socket.write(
          "250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n",
        );
      case "HELO":
      case "NOOP":
        return reply("250 OK");
      case "AUTH": {
        const method = rest[0]?.toUpperCase();
        if (method === "LOGIN") {
          login = "user";
          return reply("334 VXNlcm5hbWU6");
        }
        if (method === "PLAIN" && rest[1] === undefined) {
          login = "plain";
          return reply("334 ");
        }
        return reply("235 2.7.0 Authentication successful");
      }
      case "MAIL":
        from = /<([^>]*)>/.exec(line)?.[1] ?? "";
        recipients = [];
        return reply("250 OK");
      case "RCPT":
        recipients.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
        return reply("250 OK");
      case "DATA":
        receiving = true;
        return reply("354 End data with <CR><LF>.<CR><LF>");
      case "RSET":
        from = "";
        recipients = [];
        return reply("250 OK");
      case "QUIT":
        reply("221 Bye");
        return socket.end();
      default:
        return reply("502 Command not implemented");
    }
  };

  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (receiving) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        const body = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 5);
        const raw = body.replace(/^\.\./gm, ".");
        onMail(parseMail(from, recipients, raw));
        receiving = false;
        reply("250 OK queued");
        continue;
      }
      const eol = buffer.indexOf("\r\n");
      if (eol < 0) return;
      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + 2);
      command(line);
    }
  });
  reply("220 localhost ESMTP");
}

export function startSmtpCapture(): Promise<SmtpCapture> {
  const store: CapturedMail[] = [];
  const waiters: (() => boolean)[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handleConnection(socket, (m) => {
      store.push(m);
      for (const w of waiters.splice(0)) if (!w()) waiters.push(w);
    });
  });
  const waitForCount = (address: string, count: number) =>
    new Promise<CapturedMail[]>((resolve, reject) => {
      const check = () => {
        const found = store.filter((m) => m.recipients.includes(address));
        if (found.length < count) return false;
        clearTimeout(timer);
        resolve(found.slice(0, count));
        return true;
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`no mail to ${address} within ${WAIT_MS} ms`));
      }, WAIT_MS);
      if (!check()) waiters.push(check);
    });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        return reject(new Error("SMTP capture has no port"));
      resolve({
        port: address.port,
        messages: () => [...store],
        waitFor: (address) =>
          waitForCount(address, 1).then((mails) => mails[0]!),
        waitForCount,
        clear: () => {
          store.length = 0;
        },
        stop: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
