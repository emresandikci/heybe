import { html2text } from "./html2text";
import type { App } from "../app";
import type { Collection } from "../collections/model";
import type { RecordModel } from "../records/model";
import { valuesOf } from "../records/service";
import type { MailMessage } from "./mailer";

const LAYOUT = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
        body, html {
            padding: 0;
            margin: 0;
            border: 0;
            color: #16161a;
            background: #fff;
            font-size: 14px;
            line-height: 20px;
            font-weight: normal;
            font-family: Source Sans Pro, sans-serif, emoji;
        }
        body {
            padding: 20px 30px;
        }
        strong {
            font-weight: bold;
        }
        em, i {
            font-style: italic;
        }
        p {
            display: block;
            margin: 10px 0;
            font-family: inherit;
        }
        small {
            font-size: 12px;
            line-height: 16px;
        }
        hr {
            display: block;
            height: 1px;
            border: 0;
            width: 100%;
            background: #e1e6ea;
            margin: 10px 0;
        }
        a {
            color: inherit;
        }
        .hidden {
            display: none !important;
        }
        .btn {
            display: inline-block;
            vertical-align: top;
            border: 0;
            cursor: pointer;
            color: #fff !important;
            background: #16161a !important;
            text-decoration: none !important;
            line-height: 40px;
            width: auto;
            min-width: 150px;
            text-align: center;
            padding: 0 20px;
            margin: 5px 0;
            font-family: Source Sans Pro, sans-serif, emoji;
            font-size: 14px;
            font-weight: bold;
            border-radius: 6px;
            box-sizing: border-box;
        }
    </style>
</head>
<body>
    {{template "content" .}}
</body>
</html>
`;

const CONTENT = '{{template "content" .}}';

export function wrapLayout(body: string): string {
  return LAYOUT.replace(CONTENT, () => body);
}

export type RecordMailKind =
  "verification" | "resetPassword" | "confirmEmailChange" | "otp" | "authAlert";

interface Template {
  subject: string;
  body: string;
}

function templateOf(collection: Collection, kind: RecordMailKind): Template {
  const options = collection as unknown as Record<string, any>;
  switch (kind) {
    case "verification":
      return options.verificationTemplate;
    case "resetPassword":
      return options.resetPasswordTemplate;
    case "confirmEmailChange":
      return options.confirmEmailChangeTemplate;
    case "otp":
      return options.otp.emailTemplate;
    case "authAlert":
      return options.authAlert.emailTemplate;
  }
}

// Same characters and entities as Go html.EscapeString.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}

const RAW_TYPES = new Set(["autodate", "date", "bool", "number"]);

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined || Array.isArray(value)) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Placeholders are replaced in one pass so a record value containing "{TOKEN}" is never expanded.
function resolve(text: string, values: Map<string, string>): string {
  if (values.size === 0) return text;
  const keys = [...values.keys()].map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return text.replace(
    new RegExp(keys.join("|"), "g"),
    (key) => values.get(key) ?? key,
  );
}

export function renderRecordMail(
  app: App,
  kind: RecordMailKind,
  collection: Collection,
  record: Record<string, unknown>,
  data: Record<string, string>,
): { subject: string; html: string; text: string } {
  const { meta } = app.settings.get();
  const values = new Map<string, string>(Object.entries(data));
  if (!values.has("{APP_NAME}")) values.set("{APP_NAME}", meta.appName);
  if (!values.has("{APP_URL}")) values.set("{APP_URL}", meta.appURL);

  for (const field of collection.fields) {
    if (field.hidden) continue;
    const key = `{RECORD:${field.name}}`;
    if (values.has(key)) continue;
    const value = asString(record[field.name]);
    values.set(key, RAW_TYPES.has(field.type) ? value : escapeHtml(value));
  }

  const template = templateOf(collection, kind);
  const html = wrapLayout(resolve(template.body, values));
  return {
    subject: resolve(template.subject, values),
    html,
    text: html2text(html),
  };
}

// The record mail of `kind` to `to`, from the app sender (PB mails/record.go).
export function recordMessage(
  app: App,
  kind: RecordMailKind,
  record: RecordModel,
  data: Record<string, string>,
  to: string,
): MailMessage {
  const { meta } = app.settings.get();
  return {
    from: { name: meta.senderName, address: meta.senderAddress },
    to: [{ address: to }],
    ...renderRecordMail(app, kind, record.collection, valuesOf(record), data),
  };
}
