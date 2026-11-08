import { newMailToken } from "../../auth/tokens";
import type { Collection } from "../../collections/model";
import { isEmail } from "../../fields/email";
import {
  type RecordMailKind,
  escapeHtml,
  renderRecordMail,
} from "../../mail/templates";
import { SettingsLoadError } from "../../settings";
import { randomSecret } from "../../util";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";
import { requireSuperuser } from "./collections";

const LOAD_FAILED = "An error occurred while loading the submitted data.";

async function update(e: RequestEvent): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  try {
    e.app.settings.update(body);
  } catch (err) {
    if (err instanceof SettingsLoadError) throw new ApiError(400, LOAD_FAILED);
    throw err;
  }
  return e.json(200, e.app.settings);
}

const TEST_TEMPLATES: Record<string, RecordMailKind> = {
  verification: "verification",
  "password-reset": "resetPassword",
  "email-change": "confirmEmailChange",
  otp: "otp",
  "login-alert": "authAlert",
};

const length = (v: string) => [...v].length;

function testEmailErrors(
  form: { email: string; template: string; collection: string },
  collection: Collection | null,
): Record<string, unknown> {
  const errors: Record<string, unknown> = {};
  if (form.collection !== "") {
    if (length(form.collection) > 255)
      errors.collection = {
        code: "validation_length_out_of_range",
        message: "The length must be between 1 and 255.",
        params: { min: 1, max: 255 },
      };
    else if (collection?.type !== "auth")
      errors.collection = {
        code: "validation_invalid_auth_collection",
        message: "Must be a valid auth collection id or name.",
      };
  }
  if (form.email === "")
    errors.email = { code: "validation_required", message: "Cannot be blank." };
  else if (length(form.email) > 255)
    errors.email = {
      code: "validation_length_out_of_range",
      message: "The length must be between 1 and 255.",
      params: { min: 1, max: 255 },
    };
  else if (!isEmail(form.email))
    errors.email = {
      code: "validation_is_email",
      message: "Must be a valid email address.",
    };
  if (form.template === "")
    errors.template = {
      code: "validation_required",
      message: "Cannot be blank.",
    };
  else if (!Object.hasOwn(TEST_TEMPLATES, form.template))
    errors.template = {
      code: "validation_in_invalid",
      message: "Must be a valid value.",
    };
  return errors;
}

function testRecord(collection: Collection, email: string) {
  const record: Record<string, unknown> = {};
  for (const field of collection.fields) {
    if (field.hidden) continue;
    record[field.name] =
      field.type === "bool"
        ? false
        : field.type === "number"
          ? 0
          : field.type === "date" || field.type === "autodate"
            ? ""
            : `__pb_test_${field.name}__`;
  }
  record.tokenKey = randomSecret(50);
  record.email = email;
  return record;
}

async function testEmail(e: RequestEvent): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  const form = { email: "", template: "", collection: "" };
  for (const key of Object.keys(form) as (keyof typeof form)[]) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new ApiError(400, LOAD_FAILED);
    form[key] = v;
  }

  const collection = e.app.collections.find(form.collection || "_superusers");
  const errors = testEmailErrors(form, collection);
  if (Object.keys(errors).length > 0 || !collection)
    throw new ApiError(400, "Failed to send the test email.", errors);

  const record = testRecord(collection, form.email);
  const kind = TEST_TEMPLATES[form.template]!;
  const token = (type: "verification" | "passwordReset" | "emailChange") => ({
    "{TOKEN}": newMailToken(e.app, type, collection, record, form.email),
  });
  const data = {
    verification: () => token("verification"),
    resetPassword: () => token("passwordReset"),
    confirmEmailChange: () => token("emailChange"),
    otp: () => ({ "{OTP_ID}": "_PB_TEST_OTP_ID_", "{OTP}": "123456" }),
    authAlert: () => ({
      "{ALERT_INFO}": escapeHtml(
        `${e.app.now().toISOString().replace("T", " ")} - TEST_IP TEST_USER_AGENT`,
      ),
    }),
  }[kind]();

  const mail = renderRecordMail(e.app, kind, collection, record, data);
  const { meta } = e.app.settings.get();
  try {
    await e.app.mailer.send({
      from: { name: meta.senderName, address: meta.senderAddress },
      to: [{ address: form.email }],
      ...mail,
    });
  } catch (err) {
    throw new ApiError(
      400,
      `Failed to send the test email. Raw error: \n${err instanceof Error ? err.message : err}`,
    );
  }
  return new Response(null, { status: 204 });
}

export function registerSettingsRoutes(router: Router): void {
  router.add("GET", "/api/settings", (e) => {
    requireSuperuser(e);
    return e.json(200, e.app.settings);
  });
  router.add("PATCH", "/api/settings", (e) => {
    requireSuperuser(e);
    return update(e);
  });
  router.add("POST", "/api/settings/test/email", (e) => {
    requireSuperuser(e);
    return testEmail(e);
  });
}
