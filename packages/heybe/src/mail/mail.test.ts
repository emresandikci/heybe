import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App } from "../app";
import { testApp } from "../test-app";
import type { Collection } from "../collections/model";
import { startSmtpCapture } from "../../contract/smtp";
import { RecordModel } from "../records/model";
import { sendFlowMail, sendOtpMail } from "../auth/flows";
import { html2text } from "./html2text";
import {
  mailerFromSettings,
  sendmailMailer,
  smtpTransportOptions,
} from "./mailer";
import {
  type RecordMailKind,
  escapeHtml,
  renderRecordMail,
  wrapLayout,
} from "./templates";

let app: App;
let users: Collection;

beforeEach(async () => {
  app = testApp();
  await app.settings.update({
    meta: { appName: "Acme", appURL: "https://app.example" },
  });
  users = app.collections.find("_superusers")!;
});

afterEach(() => app.close());

const PLAIN = `
				<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
				<html xmlns="http://www.w3.org/1999/xhtml">
				<head>
				    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
				    <meta name="viewport" content="width=device-width,initial-scale=1" />
				    <style>
				        body {
				            padding: 0;
				        }
				    </style>
				</head>
				<body>
					<!-- test html comment -->
					<style>
					    body {
					        padding: 0;
					    }
					</style>
				    <div class="wrapper">
				        <div class="content">
				            <p>Lorem ipsum</p>
				            <p>Dolor sit amet</p>
				            <p>
				            	<a href="a/b/c">Verify</a>
				            </p>
				            <br>
				            <p>
				            	<a href="a/b/c"><strong>Verify2.1</strong> <strong>Verify2.2</strong></a>
				            </p>
				            <br>
				            <br>
				            <div>
				            	<div>
				            		<div>
							            <ul>
							            	<li>ul.test1</li>
							            	<li>ul.test2</li>
							            	<li>ul.test3</li>
							            </ul>
							            <ol>
							            	<li>ol.test1</li>
							            	<li>ol.test2</li>
							            	<li>ol.test3</li>
							            </ol>
				            		</div>
				            	</div>
				            </div>
				            <select>
				            	<option>Option 1</option>
				            	<option>Option 2</option>
				            </select>
				            <textarea>test</textarea>
				            <input type="text" value="test" />
				            <button>test</button>
				            <p>
				                Thanks,<br/>
				                PocketBase team
				            </p>
				        </div>
				    </div>
				</body>
				</html>
			`;

describe("html2text", () => {
  const cases: [string, string][] = [
    ["", ""],
    ["ab  c", "ab c"],
    ["<!-- test html comment -->", ""],
    ["<!-- test html comment -->   a   ", "a"],
    ["<span>a</span>b<span>c</span>", "abc"],
    [`<a href="a/b/c">test</span>`, "[test](a/b/c)"],
    [`<a href="">test</span>`, "[test]"],
    ["<span>a</span>  <span>b</span>", "a b"],
    ["<span>a</span>   b   <span>c</span>", "a b c"],
    ["<span>a</span>   b   <div>c</div>", "a b \r\nc"],
    [
      PLAIN,
      "Lorem ipsum \r\nDolor sit amet \r\n[Verify](a/b/c)  \r\n[Verify2.1 Verify2.2](a/b/c)  \r\n\r\n- ul.test1 \r\n- ul.test2 \r\n- ul.test3  \r\n- ol.test1 \r\n- ol.test2 \r\n- ol.test3         \r\nThanks,\r\nPocketBase team",
    ],
  ];
  test.each(cases)("%j", (input, expected) => {
    expect(html2text(input)).toBe(expected);
  });
});

const SIGNATURE = "<p>\n  Thanks,<br/>\n  Acme team\n</p>";
const BODIES: Record<RecordMailKind, [string, string]> = {
  verification: [
    "Verify your Acme email",
    `<p>Hello,</p>
<p>Thank you for joining us at Acme.</p>
<p>Click on the button below to verify your email address.</p>
<p>
  <a class="btn" href="https://app.example/_/#/auth/confirm-verification/TOK" target="_blank" rel="noopener">Verify</a>
</p>
<p><i>If you didn't recently register, please ignore this email.</i></p>
${SIGNATURE}`,
  ],
  resetPassword: [
    "Reset your Acme password",
    `<p>Hello,</p>
<p>Click on the button below to reset your password.</p>
<p>
  <a class="btn" href="https://app.example/_/#/auth/confirm-password-reset/TOK" target="_blank" rel="noopener">Reset password</a>
</p>
<p><i>If you didn't ask to reset your password, please ignore this email.</i></p>
${SIGNATURE}`,
  ],
  confirmEmailChange: [
    "Confirm your Acme new email address",
    `<p>Hello,</p>
<p>Click on the button below to confirm your new email address.</p>
<p>
  <a class="btn" href="https://app.example/_/#/auth/confirm-email-change/TOK" target="_blank" rel="noopener">Confirm new email</a>
</p>
<p><i>If you didn't ask to change your email address, please ignore this email.</i></p>
${SIGNATURE}`,
  ],
  otp: [
    "OTP for Acme",
    `<p>Hello,</p>
<p>Your one-time password is: <strong>123456</strong></p>
<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>
${SIGNATURE}`,
  ],
  authAlert: [
    "Login from a new location",
    `<p>Hello,</p>
<p>We noticed a login to your Acme account from a new location:</p>
<p><em>2026-01-02 03:04:05.000Z - 1.2.3.4 &lt;agent&gt;</em></p>
<p><strong>If this wasn't you, you should immediately change your Acme account password to revoke access from all other locations.</strong></p>
<p>If this was you, you may disregard this email.</p>
${SIGNATURE}`,
  ],
};

const DATA: Record<RecordMailKind, Record<string, string>> = {
  verification: { "{TOKEN}": "TOK" },
  resetPassword: { "{TOKEN}": "TOK" },
  confirmEmailChange: { "{TOKEN}": "TOK" },
  otp: { "{OTP_ID}": "id", "{OTP}": "123456" },
  authAlert: {
    "{ALERT_INFO}": escapeHtml("2026-01-02 03:04:05.000Z - 1.2.3.4 <agent>"),
  },
};

describe("renderRecordMail", () => {
  test.each(Object.keys(BODIES) as RecordMailKind[])(
    "%s renders the PocketBase default template",
    (kind) => {
      const mail = renderRecordMail(
        app,
        kind,
        users,
        { id: "r1", email: "a@example.com" },
        DATA[kind]!,
      );
      const [subject, body] = BODIES[kind];
      expect(mail.subject).toBe(subject);
      expect(mail.html).toBe(wrapLayout(body));
      expect(mail.text).toBe(html2text(mail.html));
    },
  );

  test("the text part matches the one PocketBase sent", () => {
    const mail = renderRecordMail(app, "otp", users, {}, DATA.otp!);
    expect(mail.text).toBe(
      "Hello, \r\nYour one-time password is: 123456 \r\nIf you didn't ask for the one-time password, you can ignore this email. \r\nThanks,\r\nAcme team",
    );
  });

  test("record placeholders are html escaped except date, bool and number", () => {
    const fields = [
      ...users.fields,
      { id: "t", name: "note", type: "text", system: false, hidden: false },
      { id: "n", name: "age", type: "number", system: false, hidden: false },
      { id: "h", name: "secret", type: "text", system: false, hidden: true },
    ] as Collection["fields"];
    const collection = {
      ...users,
      fields,
      verificationTemplate: {
        subject: "{RECORD:note}",
        body: "{RECORD:note}|{RECORD:age}|{RECORD:secret}|{RECORD:verified}",
      },
    } as Collection;
    const mail = renderRecordMail(
      app,
      "verification",
      collection,
      { note: `<b>&"'`, age: 5, secret: "x", verified: true },
      { "{TOKEN}": "T" },
    );
    expect(mail.subject).toBe("&lt;b&gt;&amp;&#34;&#39;");
    expect(mail.html).toContain(
      "&lt;b&gt;&amp;&#34;&#39;|5|{RECORD:secret}|true",
    );
  });

  test("a record value containing a placeholder is not expanded", () => {
    const collection = {
      ...users,
      verificationTemplate: { subject: "{RECORD:email}", body: "{TOKEN}" },
    } as Collection;
    const mail = renderRecordMail(
      app,
      "verification",
      collection,
      { email: "{TOKEN}{APP_NAME}" },
      { "{TOKEN}": "T" },
    );
    expect(mail.subject).toBe("{TOKEN}{APP_NAME}");
  });
});

describe("header safety", () => {
  const settings = (port: number) => ({
    ...app.settings.get(),
    smtp: {
      ...app.settings.get().smtp,
      enabled: true,
      host: "127.0.0.1",
      port,
      tls: false,
    },
  });

  test("CR/LF in names and subjects never creates a header", async () => {
    const capture = await startSmtpCapture();
    try {
      const evil = "Eve\r\nBcc: x@y.com";
      const collection = {
        ...users,
        verificationTemplate: { subject: "Hi {RECORD:email}", body: "b" },
      } as Collection;
      const mail = renderRecordMail(
        app,
        "verification",
        collection,
        { email: evil },
        { "{TOKEN}": "T" },
      );
      await mailerFromSettings(settings(capture.port)).send({
        from: { name: evil, address: "from@example.com" },
        to: [{ name: evil, address: "to@example.com" }],
        ...mail,
        headers: { "X-Custom": "a\r\nBcc: z@y.com" },
      });
      const [sent] = capture.messages();
      expect(sent!.recipients).toEqual(["to@example.com"]);
      const head = sent!.raw.slice(0, sent!.raw.indexOf("\r\n\r\n"));
      expect(head).not.toMatch(/^bcc:/im);
      expect(sent!.headers.bcc).toBeUndefined();
      expect(sent!.subject).toBe("Hi Eve Bcc: x@y.com");
    } finally {
      await capture.stop();
    }
  });
});

describe("mailer safety", () => {
  const smtp = (over: Record<string, unknown>) => ({
    ...app.settings.get().smtp,
    ...over,
  });

  test("credentials require TLS on a remote host without tls", () => {
    const creds = { username: "u", password: "p", tls: false };
    expect(
      smtpTransportOptions(smtp({ ...creds, host: "mail.example.com" }))
        .requireTLS,
    ).toBe(true);
    expect(
      smtpTransportOptions(smtp({ ...creds, host: "127.0.0.1" })).requireTLS,
    ).toBe(false);
    expect(
      smtpTransportOptions(smtp({ ...creds, host: "localhost" })).requireTLS,
    ).toBe(false);
    expect(
      smtpTransportOptions(
        smtp({ ...creds, host: "mail.example.com", tls: true }),
      ).requireTLS,
    ).toBe(false);
    expect(
      smtpTransportOptions(
        smtp({ host: "mail.example.com", username: "", password: "" }),
      ).requireTLS,
    ).toBe(false);
  });

  test("an address starting with a dash is rejected before sending", async () => {
    const mail = { subject: "s", html: "h", text: "t" };
    const from = { name: "", address: "from@example.com" };
    const sendmail = mailerFromSettings({
      ...app.settings.get(),
      smtp: { ...app.settings.get().smtp, enabled: false },
    });
    await expect(
      sendmail.send({
        from,
        to: [{ address: "-oQ/tmp/x@example.com" }],
        ...mail,
      }),
    ).rejects.toThrow("invalid mail address");
    await expect(
      sendmail.send({
        from: { name: "", address: "-X@example.com" },
        to: [{ address: "a@example.com" }],
        ...mail,
      }),
    ).rejects.toThrow("invalid mail address");
  });
});

describe("sendmail transport", () => {
  let dir: string;
  let mailer: ReturnType<typeof sendmailMailer>;
  const run = (exit: number) => {
    const script = join(dir, "sendmail");
    writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${dir}/argv\ncat > ${dir}/stdin\nexit ${exit}\n`,
    );
    chmodSync(script, 0o755);
  };
  const argv = () => readFileSync(join(dir, "argv"), "utf8");
  const stdin = () => readFileSync(join(dir, "stdin"), "utf8");
  const from = { name: 'Ünï "Q"', address: "from@example.com" };
  const to = [
    { address: "a@example.com" },
    { name: "B", address: "b@example.com" },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sendmail-"));
    mailer = sendmailMailer([join(dir, "sendmail")]);
    run(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("an html message is sent like PocketBase with the html as body", async () => {
    await mailer.send({
      from,
      to,
      subject:
        "Café ünïcode subject that is long enough to need splitting into words ok",
      html: "<p>hi</p>",
      text: "ignored",
      headers: {
        "x-custom": "a\r\nb ",
        "Message-ID": "<id@example.com>",
        "Bad Key": "x",
        "X:Y": "x",
      },
    });
    expect(argv()).toBe("-i\n-t\n");
    expect(stdin()).toBe(
      [
        "Content-Type: text/html; charset=UTF-8",
        "From: =?utf-8?b?w5xuw68gIlEi?= <from@example.com>",
        "Message-Id: <id@example.com>",
        "Subject: =?utf-8?q?Caf=C3=A9_=C3=BCn=C3=AFcode_subject_that_is_long_enough_to_need?= =?utf-8?q?_splitting_into_words_ok?=",
        "To: a@example.com,b@example.com",
        "X-Custom: a  b",
        "",
        "<p>hi</p>",
      ].join("\r\n"),
    );
  });

  test("a text-only message is sent as text/plain with a default message id", async () => {
    await mailer.send({
      from: { name: "Acme (x)", address: "from@example.com" },
      to: [{ address: "a@example.com" }],
      subject: "Plain",
      html: "",
      text: "body",
    });
    const [head, body] = stdin().split("\r\n\r\n");
    expect(body).toBe("body");
    expect(head!.split("\r\n")).toEqual([
      "Content-Type: text/plain; charset=UTF-8",
      'From: "Acme (x)" <from@example.com>',
      expect.stringMatching(/^Message-Id: <[\w-]{15}@example\.com>$/),
      "Subject: Plain",
      "To: a@example.com",
    ]);
  });

  test("a failing sendmail gives the exit status as error", async () => {
    run(3);
    await expect(
      mailer.send({
        from,
        to,
        subject: "s",
        html: "",
        text: "t",
      }),
    ).rejects.toThrow("exit status 3");
  });

  test("a missing sendmail binary gives PocketBase's error", async () => {
    await expect(
      sendmailMailer([join(dir, "none")]).send({
        from,
        to,
        subject: "s",
        html: "",
        text: "t",
      }),
    ).rejects.toThrow("failed to locate a sendmail executable path");
  });
});

describe("record mails", () => {
  test("a record mail to a record without a string email throws missing record email", async () => {
    for (const email of [undefined, "", 5]) {
      const record = new RecordModel(users, { id: "r1", email }, false);
      await expect(sendFlowMail(app, "verification", record)).rejects.toThrow(
        "missing record email",
      );
      await expect(sendOtpMail(app, record, "o1", "123456")).rejects.toThrow(
        "missing record email",
      );
    }
  });
});
