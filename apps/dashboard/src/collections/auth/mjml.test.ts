import { expect, test } from "bun:test";
import { compileMjml, readSource, stripSource, withSource } from "./mjml";
import { TEMPLATE_KINDS, mjmlStarter } from "./mjml-starters";

test("the MJML source round trips through the marker, unicode included", () => {
  const source = "<mjml><mj-body>Merhaba ğüşİ 👋</mj-body></mjml>";
  const body = withSource("<p>html</p>", source);
  expect(body).toMatch(/\n<!-- heybe:mjml:[A-Za-z0-9+/=]+ -->$/);
  expect(readSource(body)).toBe(source);
  expect(stripSource(body)).toBe("<p>html</p>");
  expect(readSource("<p>plain</p>")).toBeNull();
  expect(readSource("<p>x</p>\n<!-- heybe:mjml:%%% -->")).toBeNull();
});

test("every starter compiles and keeps its placeholders, in text and in href", async () => {
  for (const kind of TEMPLATE_KINDS)
    for (const superuser of [false, true]) {
      const source = mjmlStarter(kind, superuser);
      const { html, errors } = await compileMjml(source);
      expect(errors).toEqual([]);
      expect(html).toContain("{APP_NAME}");
      const placeholder = {
        verification: 'href="{APP_URL}/_/#/auth/confirm-verification/{TOKEN}"',
        resetPassword:
          'href="{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}"',
        confirmEmailChange:
          'href="{APP_URL}/_/#/auth/confirm-email-change/{TOKEN}"',
        otp: "{OTP}",
        authAlert: "{ALERT_INFO}",
      }[kind];
      expect(html).toContain(placeholder);
    }
});

test("compiled HTML is a body fragment for the server layout", async () => {
  const { html } = await compileMjml(
    "<mjml><mj-head><mj-title>T</mj-title></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {RECORD:name}</mj-text></mj-column></mj-section></mj-body></mjml>",
  );
  expect(html).toContain("Hi {RECORD:name}");
  expect(html).toContain("<style");
  expect(html).not.toMatch(/<\/?(html|head|body|title)[\s>]/i);
  expect(html).not.toMatch(/<meta /i);
});

test("compile errors come back as messages with their line", async () => {
  const { errors } = await compileMjml(
    '<mjml><mj-body><mj-section><mj-column><mj-text foo="1">x</mj-text></mj-column></mj-section></mj-body></mjml>',
  );
  expect(errors).toEqual(["Line 1: Attribute foo is illegal"]);
});

test("starters use system fonts and no web font links", async () => {
  const { html } = await compileMjml(mjmlStarter("verification", false));
  expect(html).not.toContain("fonts.googleapis");
  expect(html).toContain("-apple-system");
});

test("a failed chunk load is reported and retried on the next compile", async () => {
  const failing = () => Promise.reject(new Error("Chunk failed to load."));
  expect(await compileMjml("<mjml></mjml>", failing)).toEqual({
    html: "",
    errors: ["Chunk failed to load."],
  });
  const { errors } = await compileMjml(mjmlStarter("otp", false));
  expect(errors).toEqual([]);
});
