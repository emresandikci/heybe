import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Target, both, expectSame, startTargets } from "./harness";
import { type CapturedMail, type SmtpCapture, startSmtpCapture } from "./smtp";

let targets: Awaited<ReturnType<typeof startTargets>>;
let mail: { pocketbase: SmtpCapture; heybe: SmtpCapture };

beforeAll(async () => {
  mail = {
    pocketbase: await startSmtpCapture(),
    heybe: await startSmtpCapture(),
  };
  targets = await startTargets();
  await both((t) =>
    api(t, "PATCH", "/api/settings", {
      meta: {
        appName: "Acme",
        appURL: "https://app.example",
        senderName: "Acme Support",
        senderAddress: "support@example.com",
      },
      smtp: {
        enabled: true,
        host: "127.0.0.1",
        port: mail[t.name].port,
        tls: false,
        username: "",
        password: "",
      },
    }),
  );
  await both((t) =>
    api(t, "POST", "/api/collections", {
      name: "members",
      type: "auth",
      fields: [
        { name: "name", type: "text" },
        { name: "active", type: "bool" },
        { name: "age", type: "number" },
      ],
      verificationTemplate: {
        subject: "Welcome {RECORD:name} to {APP_NAME}",
        body: "<p>{RECORD:name}|{RECORD:active}|{RECORD:age}|{RECORD:email}|{RECORD:tokenKey}|{TOKEN}</p>",
      },
    }),
  );
}, 60_000);

afterAll(async () => {
  await targets.stop();
  await Promise.all([mail.pocketbase.stop(), mail.heybe.stop()]);
});

const api = (
  t: Target,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = t.superToken,
) =>
  fetch(`${t.url}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: token }),
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
  });

const TOKEN = /[\w-]+\.[\w-]+\.[\w-]+/g;
const NOW = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const MESSAGE_ID = /^<[^@]+@example\.com>$/;

function normalized(m: CapturedMail) {
  const clean = (s: string) =>
    s
      .replace(TOKEN, "<token>")
      .replace(NOW, "<now>")
      .replace(/\r\n/g, "\n")
      .replaceAll("__hb_test_", "__pb_test_");
  return {
    from: m.from,
    recipients: m.recipients,
    fromHeader: m.headers.from,
    to: m.to,
    subject: clean(m.subject),
    html: clean(m.html),
    text: clean(m.text),
    messageIdShape: MESSAGE_ID.test(m.headers["message-id"]?.[0] ?? ""),
  };
}

async function send(body: unknown, status = 204) {
  mail.pocketbase.clear();
  mail.heybe.clear();
  const [pb, hb] = await both((t) =>
    api(t, "POST", "/api/settings/test/email", body),
  );
  expect(pb.status).toBe(status);
  expectSame(pb, hb);
  return [mail.pocketbase.messages(), mail.heybe.messages()] as const;
}

async function sameMail(body: unknown): Promise<CapturedMail> {
  const [pb, hb] = await send(body);
  expect(pb).toHaveLength(1);
  expect(hb).toHaveLength(1);
  expect(normalized(hb[0]!)).toEqual(normalized(pb[0]!));
  return pb[0]!;
}

describe("test email", () => {
  for (const template of [
    "verification",
    "password-reset",
    "email-change",
    "otp",
    "login-alert",
  ])
    test(`${template} for the default collection`, async () => {
      const sent = await sameMail({ email: "to@example.com", template });
      expect(sent.recipients).toEqual(["to@example.com"]);
    });

  test("a custom auth collection with record placeholders", async () => {
    await sameMail({
      email: "to@example.com",
      template: "verification",
      collection: "members",
    });
  });

  test("the collection can be given by id", async () => {
    mail.pocketbase.clear();
    mail.heybe.clear();
    const [pb, hb] = await both(async (t) => {
      const { id } = (await (
        await api(t, "GET", "/api/collections/members")
      ).json()) as { id: string };
      return api(t, "POST", "/api/settings/test/email", {
        email: "to@example.com",
        template: "verification",
        collection: id,
      });
    });
    expect(pb.status).toBe(204);
    expectSame(pb, hb);
    expect(normalized(mail.heybe.messages()[0]!)).toEqual(
      normalized(mail.pocketbase.messages()[0]!),
    );
  });

  test("validation errors", async () => {
    await send({}, 400);
    await send({ email: "nope", template: "nope" }, 400);
    await send(
      { email: "a@example.com", template: "otp", collection: "nope" },
      400,
    );
    await send(
      { email: "a@example.com", template: "otp", collection: "posts" },
      400,
    );
    await send(
      { email: `${"a".repeat(250)}@example.com`, template: "otp" },
      400,
    );
    await send({ email: "a@example.com", template: "x".repeat(10) }, 400);
    await send({ email: 1, template: "otp" }, 400);
    await send("{bad", 400);
  });

  test("only superusers may send", async () => {
    const [none, user] = await Promise.all([
      both((t) => api(t, "POST", "/api/settings/test/email", {}, null)),
      both((t) => api(t, "POST", "/api/settings/test/email", {}, "x.y.z")),
    ]);
    expect(none[0].status).toBe(401);
    expectSame(...none);
    expectSame(...user);
  });

  test("an unreachable server is a 400 with the raw error", async () => {
    await both((t) => api(t, "PATCH", "/api/settings", { smtp: { port: 1 } }));
    try {
      const [pb, hb] = await both((t) =>
        api(t, "POST", "/api/settings/test/email", {
          email: "to@example.com",
          template: "otp",
        }),
      );
      for (const snap of [pb, hb]) {
        expect(snap.status).toBe(400);
        expect((snap.body as { message: string }).message).toStartWith(
          "Failed to send the test email. Raw error:",
        );
      }
    } finally {
      await both((t) =>
        api(t, "PATCH", "/api/settings", {
          smtp: { port: mail[t.name].port },
        }),
      );
    }
  });
});
