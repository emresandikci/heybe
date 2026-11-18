import type { App } from "../app";
import { errorMessage } from "../util";
import { html2text } from "./html2text";

// Port of PB core/system_alert.go.

// Go html/template escaping of text in an HTML element
const templateEscape = (s: string) =>
  s.replace(
    /[\0"&'+<>]/g,
    (c) =>
      ({
        "\0": "\uFFFD",
        '"': "&#34;",
        "&": "&amp;",
        "'": "&#39;",
        "+": "&#43;",
        "<": "&lt;",
        ">": "&gt;",
      })[c]!,
  );

// Go html.EscapeString
const escapeString = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&#39;",
        '"': "&#34;",
      })[c]!,
  );

const systemAlertHTML = (
  appName: string,
  details: string,
) => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
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
        p {
            display: block;
            margin: 10px 0;
            font-family: inherit;
        }
        small {
            font-size: 12px;
            line-height: 16px;
        }
        strong {
            font-weight: bold;
        }
        em, i {
            font-style: italic;
        }
        a {
            color: inherit;
        }
        .alert {
        	padding: 15px;
        	background: #e4e8ec;
        	border-radius: 5px;
        	white-space: pre-wrap;
        }
    </style>
</head>
<body>
	<p>${templateEscape(appName)} system alert occurred:</p>
	<p class="alert"><strong>${templateEscape(details)}</strong></p>
	<p>For more information you could explore the logs in the dashboard of your application.</p>
</body>
</html>`;

export async function sendSystemAlertToAllSuperusers(
  app: App,
  subject: string,
  details: string,
): Promise<void> {
  const { meta } = app.settings.current();
  const superusers = app.db.query<{ email: string }>(
    "SELECT email FROM _superusers",
  );
  const html = systemAlertHTML(meta.appName, details);
  const errors: unknown[] = [];
  for (const { email } of superusers) {
    try {
      await app.mailer.send({
        from: { name: meta.senderName, address: meta.senderAddress },
        to: [{ address: email }],
        subject: `[${meta.appName} system alert] ${escapeString(subject)}`,
        html,
        text: html2text(html),
      });
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, errors.map(errorMessage).join("\n"));
}
