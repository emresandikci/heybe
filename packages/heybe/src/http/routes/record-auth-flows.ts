import type { App } from "../../app";
import {
  findAuthRecordByEmail,
  inBackground,
  passwordResetResendKey,
  resendLimit,
  sendFlowMail,
  verificationResendKey,
} from "../../auth/flows";
import { decodeJwtClaims } from "../../auth/jwt";
import { authFromToken } from "../../auth/tokens";
import type { Collection } from "../../collections/model";
import { isEmail } from "../../fields/email";
import { runeLength } from "../../fields/shared";
import { ValidationError, randomSecret } from "../../util";
import { ApiError } from "../errors";
import type { AuthState, RequestEvent, Router } from "../router";
import { findAuthCollection, verifyPassword } from "./record-auth";

type Values = Record<string, unknown>;
type FieldError = {
  code: string;
  message: string;
  params?: Record<string, unknown>;
};

const LOAD_FAILED = "An error occurred while loading the submitted data.";

const err = (code: string, message: string): FieldError => ({
  code,
  message,
});
const required = err("validation_required", "Cannot be blank.");
const invalidToken = err(
  "validation_invalid_token",
  "Invalid or expired token.",
);
const collectionMismatch = err(
  "validation_token_collection_mismatch",
  "The provided token is for different auth collection.",
);
const lengthError = (min: number, max: number): FieldError => ({
  code: "validation_length_out_of_range",
  message: `The length must be between ${min} and ${max}.`,
  params: { min, max },
});

const noContent = () => new Response(null, { status: 204 });

async function readForm<K extends string>(
  e: RequestEvent,
  keys: K[],
): Promise<Record<K, string>> {
  let body: Values;
  try {
    body = await e.body();
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) throw error;
    throw new ApiError(400, LOAD_FAILED);
  }
  const multipart = (e.req.headers.get("content-type") ?? "").startsWith(
    "multipart/form-data",
  );
  const form = {} as Record<K, string>;
  for (const key of keys) {
    const v = body[key];
    if (typeof v === "string") form[key] = v;
    else if (v === undefined || v === null) form[key] = "";
    // multipart values come inferred, PB binds the raw strings
    else if (multipart && (typeof v === "number" || typeof v === "boolean"))
      form[key] = String(v);
    else throw new ApiError(400, LOAD_FAILED);
  }
  return form;
}

function check(errors: Record<string, FieldError | null>): void {
  const failed = Object.entries(errors).filter(([, v]) => v !== null);
  if (failed.length > 0)
    throw new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      Object.fromEntries(failed),
    );
}

function emailError(v: string): FieldError | null {
  if (v === "") return required;
  if (runeLength(v) > 255) return lengthError(1, 255);
  if (!isEmail(v))
    return err("validation_is_email", "Must be a valid email address.");
  return null;
}

async function save(
  app: App,
  c: Collection,
  record: Values,
  data: Values,
  message: string,
): Promise<void> {
  try {
    await app.records(c.name).update(record.id as string, data);
  } catch (error) {
    if (error instanceof ValidationError)
      throw new ApiError(400, message, error.data);
    throw error;
  }
}

// PB RequireSameCollectionContextAuth (with the collection lookup of the rate limit middleware before it).
function requireCollectionAuth(e: RequestEvent): AuthState {
  const c = e.app.collections.find(e.params.collection!);
  if (!c) throw new ApiError(404, "Missing or invalid collection context.");
  if (!e.auth)
    throw new ApiError(
      401,
      "The request requires valid record authorization token.",
    );
  if (e.auth.collection.id !== c.id)
    throw new ApiError(
      403,
      `The request requires auth record from ${e.auth.collection.name} collection.`,
    );
  return e.auth;
}

const passwordAuthEnabled = (c: Collection) =>
  (c.passwordAuth as { enabled: boolean }).enabled;

async function requestVerification(e: RequestEvent): Promise<Response> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers are verified by default.");
  const { email } = await readForm(e, ["email"]);
  check({ email: emailError(email) });

  // unknown, verified and throttled get the same 204 without a mail
  const record = findAuthRecordByEmail(e.app, c, email);
  if (!record || record.verified === true) return noContent();
  const key = verificationResendKey(c, record);
  if (resendLimit.has(e.app, key)) return noContent();

  const app = e.app;
  inBackground(async () => {
    try {
      await sendFlowMail(app, "verification", c, record);
    } catch (error) {
      console.error("heybe: failed to send verification email:", error);
    }
    resendLimit.set(app, key);
  });
  return noContent();
}

function verificationTokenError(
  app: App,
  c: Collection,
  token: string,
): FieldError | null {
  const email = decodeJwtClaims(token)?.email;
  if (typeof email !== "string" || email === "")
    return err("validation_invalid_token_claims", "Missing email token claim.");
  const auth = authFromToken(app, token, "verification");
  if (!auth) return invalidToken;
  if (auth.collection.id !== c.id) return collectionMismatch;
  if (auth.record.email !== email)
    return err(
      "validation_token_email_mismatch",
      "The record email doesn't match with the requested token claims.",
    );
  return null;
}

async function confirmVerification(e: RequestEvent): Promise<Response> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers are verified by default.");
  const { token } = await readForm(e, ["token"]);
  check({
    token: token === "" ? required : verificationTokenError(e.app, c, token),
  });
  const auth = authFromToken(e.app, token, "verification");
  if (!auth) throw new ApiError(400, "Invalid or expired verification token.");

  const { record } = auth;
  // a reused token is accepted but changes nothing, as in PB
  if (record.verified !== true) {
    const data: Values = { verified: true };
    // like PB: guards against pre-hijacking if password auth is enabled later
    if (!passwordAuthEnabled(c)) data.password = randomSecret(30);
    await save(
      e.app,
      c,
      record,
      data,
      "An error occurred while saving the verified state.",
    );
  }
  resendLimit.remove(e.app, verificationResendKey(c, record));
  return noContent();
}

async function requestPasswordReset(e: RequestEvent): Promise<Response> {
  const c = findAuthCollection(e);
  if (!passwordAuthEnabled(c))
    throw new ApiError(
      400,
      "The collection is not configured to allow password authentication.",
    );
  const { email } = await readForm(e, ["email"]);
  check({ email: emailError(email) });

  const record = findAuthRecordByEmail(e.app, c, email);
  if (!record) return noContent();
  const key = passwordResetResendKey(c, record);
  if (resendLimit.has(e.app, key)) return noContent();

  const app = e.app;
  inBackground(async () => {
    try {
      await sendFlowMail(app, "passwordReset", c, record);
    } catch (error) {
      console.error("heybe: failed to send password reset email:", error);
      return;
    }
    resendLimit.set(app, key);
  });
  return noContent();
}

async function confirmPasswordReset(e: RequestEvent): Promise<Response> {
  const c = findAuthCollection(e);
  const form = await readForm(e, ["token", "password", "passwordConfirm"]);
  const field = c.fields.find((f) => f.name === "password");
  const min = Number(field?.min) > 0 ? Number(field!.min) : 1;
  const tokenError = () => {
    const auth = authFromToken(e.app, form.token, "passwordReset");
    if (!auth) return invalidToken;
    return auth.collection.id !== c.id ? collectionMismatch : null;
  };
  const length = runeLength(form.password);
  check({
    token: form.token === "" ? required : tokenError(),
    password:
      form.password === ""
        ? required
        : length < min || length > 255
          ? lengthError(min, 255)
          : null,
    passwordConfirm:
      form.passwordConfirm === ""
        ? required
        : form.passwordConfirm !== form.password
          ? err("validation_values_mismatch", "Values don't match.")
          : null,
  });
  const auth = authFromToken(e.app, form.token, "passwordReset");
  if (!auth)
    throw new ApiError(400, "Invalid or expired password reset token.");

  const { record } = auth;
  const data: Values = { password: form.password };
  // mark as verified only if the email hasn't changed since the token was issued
  if (
    record.verified !== true &&
    record.email === decodeJwtClaims(form.token)?.email
  )
    data.verified = true;
  await save(e.app, c, record, data, "Failed to set new password.");
  resendLimit.remove(e.app, passwordResetResendKey(c, record));
  return noContent();
}

async function requestEmailChange(e: RequestEvent): Promise<Response> {
  const { record } = requireCollectionAuth(e);
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers can change their emails directly.");
  const { newEmail } = await readForm(e, ["newEmail"]);
  const taken = () => {
    const found = findAuthRecordByEmail(e.app, c, newEmail);
    return found && found.id !== record.id
      ? err("validation_invalid_new_email", "Invalid new email address.")
      : null;
  };
  check({
    newEmail:
      emailError(newEmail) ??
      (newEmail === record.email
        ? err("validation_not_in_invalid", "Must not be in list.")
        : taken()),
  });

  try {
    await sendFlowMail(e.app, "emailChange", c, record, newEmail);
  } catch {
    throw new ApiError(400, "Failed to request email change.");
  }
  return noContent();
}

function parseEmailChangeToken(
  app: App,
  c: Collection,
  token: string,
): { record: Values; newEmail: string } | FieldError {
  const newEmail = decodeJwtClaims(token)?.newEmail;
  if (typeof newEmail !== "string" || newEmail === "")
    return err(
      "validation_invalid_token_payload",
      "Invalid token payload - newEmail must be set.",
    );
  const auth = authFromToken(app, token, "emailChange");
  if (!auth) return invalidToken;
  if (auth.collection.id !== c.id) return collectionMismatch;
  if (findAuthRecordByEmail(app, c, newEmail))
    return err(
      "validation_invalid_token_email",
      "The new email address is invalid.",
    );
  return { record: auth.record, newEmail };
}

async function confirmEmailChange(e: RequestEvent): Promise<Response> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers can change their emails directly.");
  const form = await readForm(e, ["token", "password"]);
  const parsed = parseEmailChangeToken(e.app, c, form.token);
  const passwordError = async () => {
    if (form.password === "") return required;
    if (runeLength(form.password) > 100) return lengthError(1, 100);
    return "record" in parsed &&
      (await verifyPassword(parsed.record, form.password))
      ? null
      : err(
          "validation_invalid_password",
          "Missing or invalid auth record password.",
        );
  };
  check({
    token: form.token === "" ? required : "record" in parsed ? null : parsed,
    password: await passwordError(),
  });
  if (!("record" in parsed))
    throw new ApiError(400, "Invalid or expired token.");

  await save(
    e.app,
    c,
    parsed.record,
    { email: parsed.newEmail, verified: true },
    "Failed to confirm email change.",
  );
  return noContent();
}

export function registerRecordAuthFlowRoutes(router: Router): void {
  const base = "/api/collections/{collection}";
  router.add("POST", `${base}/request-verification`, requestVerification);
  router.add("POST", `${base}/confirm-verification`, confirmVerification);
  router.add("POST", `${base}/request-password-reset`, requestPasswordReset);
  router.add("POST", `${base}/confirm-password-reset`, confirmPasswordReset);
  router.add("POST", `${base}/request-email-change`, requestEmailChange);
  router.add("POST", `${base}/confirm-email-change`, confirmEmailChange);
}
