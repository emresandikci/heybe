import {
  type AppleSecretForm,
  appleFormErrors,
  generateAppleClientSecret,
} from "../../auth/apple";
import { sendAuthAlert } from "../../auth/alerts";
import { sendFlowMail, sendOtpMail } from "../../auth/flows";
import type { Collection } from "../../collections/model";
import { isEmail } from "../../fields/email";
import { s3Filesystem } from "../../files/s3";
import type { RecordMailKind } from "../../mail/templates";
import { RecordModel } from "../../records/model";
import {
  SettingsListRequestEvent,
  SettingsUpdateRequestEvent,
} from "../../hooks/events";
import { SettingsLoadError, publicSettings } from "../../settings";
import { randomSecret } from "../../util";
import { ApiError, LOAD_FAILED, loadBody } from "../errors";
import type { RequestEvent, Router } from "../router";
import { requireSuperuser } from "./collections";

function list(e: RequestEvent): unknown {
  const hook = e.app.hooks.onSettingsListRequest;
  if (hook.length === 0) return e.json(200, e.app.settings);
  const event = SettingsListRequestEvent.from(e, {
    settings: e.app.settings.get(),
  });
  return hook.trigger(event, (le) => {
    le.json(200, publicSettings(le.settings));
  });
}

async function update(e: RequestEvent): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  let newSettings;
  try {
    newSettings = e.app.settings.bind(body);
  } catch (err) {
    if (err instanceof SettingsLoadError) throw new ApiError(400, LOAD_FAILED);
    throw err;
  }
  const event = SettingsUpdateRequestEvent.from(e, {
    oldSettings: e.app.settings.get(),
    newSettings,
  });
  await e.app.hooks.onSettingsUpdateRequest.trigger(event, async (ue) => {
    await ue.app.settings.save(ue.newSettings);
    ue.json(200, ue.app.settings);
  });
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

  const record = new RecordModel(
    collection,
    testRecord(collection, form.email),
    false,
  );
  const send = {
    verification: () => sendFlowMail(e.app, "verification", record),
    resetPassword: () => sendFlowMail(e.app, "passwordReset", record),
    confirmEmailChange: () =>
      sendFlowMail(e.app, "emailChange", record, form.email),
    otp: () => sendOtpMail(e.app, record, "_PB_TEST_OTP_ID_", "123456"),
    authAlert: () =>
      sendAuthAlert(
        e.app,
        record,
        `${e.app.now().toISOString().replace("T", " ")} - TEST_IP TEST_USER_AGENT`,
      ),
  }[TEST_TEMPLATES[form.template]!];
  try {
    await send();
  } catch (err) {
    throw new ApiError(
      400,
      `Failed to send the test email. Raw error: \n${err instanceof Error ? err.message : err}`,
    );
  }
  return new Response(null, { status: 204 });
}

// PB forms.TestS3Filesystem
async function testS3(e: RequestEvent): Promise<Response> {
  const body = await loadBody(e);
  const filesystem = body.filesystem ?? "";
  if (typeof filesystem !== "string") throw new ApiError(400, LOAD_FAILED);
  if (filesystem === "")
    throw new ApiError(400, "Failed to test the S3 filesystem.", {
      filesystem: { code: "validation_required", message: "Cannot be blank." },
    });
  if (filesystem !== "storage" && filesystem !== "backups")
    throw new ApiError(400, "Failed to test the S3 filesystem.", {
      filesystem: {
        code: "validation_in_invalid",
        message: "Must be a valid value.",
      },
    });

  const settings = e.app.settings.get();
  const config = filesystem === "backups" ? settings.backups.s3 : settings.s3;
  const fail = (raw: string) =>
    new ApiError(400, `Failed to test the S3 filesystem. Raw error: \n${raw}`);
  if (!config.enabled) throw fail("S3 storage filesystem is not enabled");

  const fs = s3Filesystem(config);
  const prefix = `pb_settings_test_${randomSecret(5)}/`;
  try {
    await fs.write(`${prefix}test.txt`, new TextEncoder().encode("test"));
  } catch (err) {
    throw fail(`failed to upload a test file: ${(err as Error).message}`);
  }
  try {
    await fs.deletePrefix(prefix);
  } catch (err) {
    throw fail(`failed to delete a test file: ${(err as Error).message}`);
  }
  return new Response(null, { status: 204 });
}

async function appleClientSecret(e: RequestEvent): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  const form: AppleSecretForm = {
    clientId: "",
    teamId: "",
    keyId: "",
    privateKey: "",
    duration: 0,
  };
  for (const key of ["clientId", "teamId", "keyId", "privateKey"] as const) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new ApiError(400, LOAD_FAILED);
    form[key] = v;
  }
  const duration = body.duration ?? 0;
  if (typeof duration !== "number" || !Number.isInteger(duration))
    throw new ApiError(400, LOAD_FAILED);
  form.duration = duration;

  const errors = appleFormErrors(form);
  if (Object.keys(errors).length > 0)
    throw new ApiError(400, "Invalid client secret data.", errors);
  try {
    const secret = await generateAppleClientSecret(form, e.app.now());
    return e.json(200, { secret });
  } catch (err) {
    throw new ApiError(
      400,
      `Failed to generate client secret. Raw error: \n${(err as Error).message}`,
    );
  }
}

export function registerSettingsRoutes(router: Router): void {
  router.route("GET", "/api/settings", (e) => {
    requireSuperuser(e);
    return list(e);
  });
  router.route("PATCH", "/api/settings", (e) => {
    requireSuperuser(e);
    return update(e);
  });
  router.route("POST", "/api/settings/test/email", (e) => {
    requireSuperuser(e);
    return testEmail(e);
  });
  router.route("POST", "/api/settings/test/s3", (e) => {
    requireSuperuser(e);
    return testS3(e);
  });
  router.route("POST", "/api/settings/apple/generate-client-secret", (e) => {
    requireSuperuser(e);
    return appleClientSecret(e);
  });
}
