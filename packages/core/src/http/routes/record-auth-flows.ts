import type { App } from "../../app";
import {
  findAuthRecordByEmail,
  inBackground,
  randomPassword,
  sendOtpMail,
  passwordResetResendKey,
  resendLimit,
  sendFlowMail,
  verificationResendKey,
} from "../../auth/flows";
import { decodeJwtClaims } from "../../auth/jwt";
import {
  deleteExpiredOtps,
  deleteOtp,
  findOtp,
  generateOtpCode,
  hasExpired,
  issueOtp,
  otpDurationMs,
  otpLength,
} from "../../auth/otp";
import { authFromToken, newAuthToken } from "../../auth/tokens";
import type { Collection } from "../../collections/model";
import { isEmail } from "../../fields/email";
import { runeLength } from "../../fields/shared";
import { RecordModel } from "../../records/model";
import { StaleTokenError, valuesOf } from "../../records/service";
import {
  RecordAuthWithOTPRequestEvent,
  RecordConfirmEmailChangeRequestEvent,
  RecordConfirmPasswordResetRequestEvent,
  RecordConfirmVerificationRequestEvent,
  RecordCreateOTPRequestEvent,
  RecordRequestEmailChangeRequestEvent,
  RecordRequestPasswordResetRequestEvent,
  RecordRequestVerificationRequestEvent,
} from "../../hooks/events";
import { NotFoundError, ValidationError, newId } from "../../util";
import { ApiError, logUnexpected } from "../errors";
import { checkRateLimit, collectionPathRateLimit } from "../rate-limit";
import type { AuthState, RequestEvent, RouteAction, Router } from "../router";
import { requireSuperuser } from "./collections";
import {
  authResponse,
  findAuthCollection,
  verifyPassword,
} from "./record-auth";
import { internalRecords } from "../../records/internal";

type Values = Record<string, unknown>;
type FieldIssue = {
  code: string;
  message: string;
  params?: Record<string, unknown>;
};

const LOAD_FAILED = "An error occurred while loading the submitted data.";

const err = (code: string, message: string): FieldIssue => ({
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
const lengthError = (min: number, max: number): FieldIssue => ({
  code: "validation_length_out_of_range",
  message: `The length must be between ${min} and ${max}.`,
  params: { min, max },
});

const noContent = () => new Response(null, { status: 204 });
const OTP_ATTEMPTS = { label: "", audience: "", maxRequests: 5, duration: 180 };

async function loadBody(e: RequestEvent): Promise<Values> {
  try {
    return await e.body();
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) throw error;
    throw new ApiError(400, LOAD_FAILED);
  }
}

async function readForm<K extends string>(
  e: RequestEvent,
  keys: K[],
  body?: Values,
): Promise<Record<K, string>> {
  body ??= await loadBody(e);
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

function check(errors: Record<string, FieldIssue | null>): void {
  const failed = Object.entries(errors).filter(([, v]) => v !== null);
  if (failed.length > 0)
    throw new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      Object.fromEntries(failed),
    );
}

function emailError(v: string): FieldIssue | null {
  if (v === "") return required;
  if (runeLength(v) > 255) return lengthError(1, 255);
  if (!isEmail(v))
    return err("validation_is_email", "Must be a valid email address.");
  return null;
}

// The hooked save of `record`. `tokenKey`: the one the request's token was checked against, so a
// token is used only once.
async function save(
  app: App,
  record: RecordModel,
  message: string,
  tokenKey?: string,
): Promise<void> {
  const records = internalRecords(app, record.collection.name);
  try {
    const p = await records.prepare({}, record.id);
    await records.commit(p, () =>
      records.savePrepared(p, record, { tokenKey }),
    );
  } catch (error) {
    if (error instanceof StaleTokenError) check({ token: invalidToken });
    throw failed(error, message);
  }
}

// PB firstApiError(err, e.BadRequestError(message, err))
function failed(error: unknown, message: string): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ValidationError)
    return new ApiError(400, message, error.data);
  logUnexpected(error);
  return new ApiError(400, message);
}

const model = (c: Collection, values: Values) =>
  new RecordModel(c, values, false);

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

async function requestVerification(e: RequestEvent): Promise<unknown> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers are verified by default.");
  const { email } = await readForm(e, ["email"]);
  check({ email: emailError(email) });

  // unknown and throttled get the same 204 without a mail
  const found = findAuthRecordByEmail(e.app, c, email);
  if (!found) return noContent();
  const key = verificationResendKey(c, found);
  if (found.verified !== true && resendLimit.has(e.app, key))
    return noContent();

  const event = RecordRequestVerificationRequestEvent.from(e, {
    collection: c,
    record: model(c, found),
  });
  await e.app.hooks.onRecordRequestVerificationRequest.trigger(event, (ve) => {
    if (ve.record.get("verified") === true) {
      ve.noContent(204);
      return;
    }
    const { app, record } = ve;
    inBackground(app, async () => {
      try {
        await sendFlowMail(app, "verification", record);
      } catch (error) {
        app.logger.error("Failed to send verification email", { error });
      }
      resendLimit.set(app, key);
    });
    ve.noContent(204);
  });
}

function verificationTokenError(
  app: App,
  c: Collection,
  token: string,
): FieldIssue | null {
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

async function confirmVerification(e: RequestEvent): Promise<void> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers are verified by default.");
  const { token } = await readForm(e, ["token"]);
  check({
    token: token === "" ? required : verificationTokenError(e.app, c, token),
  });
  const auth = authFromToken(e.app, token, "verification");
  if (!auth) throw new ApiError(400, "Invalid or expired verification token.");

  // a reused token is accepted but changes nothing, as in PB
  const wasVerified = auth.record.verified === true;
  const event = RecordConfirmVerificationRequestEvent.from(e, {
    collection: c,
    record: model(c, auth.record),
  });
  await e.app.hooks.onRecordConfirmVerificationRequest.trigger(
    event,
    async (ve) => {
      if (!wasVerified) {
        ve.record.set("verified", true);
        // like PB: guards against pre-hijacking if password auth is enabled later
        if (!passwordAuthEnabled(ve.record.collection))
          ve.record.set("password", await randomPassword(ve.record.collection));
        await save(
          ve.app,
          ve.record,
          "An error occurred while saving the verified state.",
        );
      }
      resendLimit.remove(
        ve.app,
        verificationResendKey(ve.record.collection, valuesOf(ve.record)),
      );
      ve.noContent(204);
    },
  );
}

async function requestPasswordReset(e: RequestEvent): Promise<unknown> {
  const c = findAuthCollection(e);
  if (!passwordAuthEnabled(c))
    throw new ApiError(
      400,
      "The collection is not configured to allow password authentication.",
    );
  const { email } = await readForm(e, ["email"]);
  check({ email: emailError(email) });

  const found = findAuthRecordByEmail(e.app, c, email);
  if (!found) return noContent();
  const key = passwordResetResendKey(c, found);
  if (resendLimit.has(e.app, key)) return noContent();

  const event = RecordRequestPasswordResetRequestEvent.from(e, {
    collection: c,
    record: model(c, found),
  });
  await e.app.hooks.onRecordRequestPasswordResetRequest.trigger(event, (re) => {
    const { app, record } = re;
    inBackground(app, async () => {
      try {
        await sendFlowMail(app, "passwordReset", record);
      } catch (error) {
        app.logger.error("Failed to send password reset email", { error });
        return;
      }
      resendLimit.set(app, key);
    });
    re.noContent(204);
  });
}

async function confirmPasswordReset(e: RequestEvent): Promise<void> {
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

  // like PB, the final action works on the record of the token
  const record = model(c, auth.record);
  const tokenKey = auth.record.tokenKey as string;
  const event = RecordConfirmPasswordResetRequestEvent.from(e, {
    collection: c,
    record,
  });
  await e.app.hooks.onRecordConfirmPasswordResetRequest.trigger(
    event,
    async (re) => {
      record.set("password", form.password);
      // mark as verified only if the email hasn't changed since the token was issued
      if (
        record.get("verified") !== true &&
        record.get("email") === decodeJwtClaims(form.token)?.email
      )
        record.set("verified", true);
      await save(re.app, record, "Failed to set new password.", tokenKey);
      resendLimit.remove(re.app, passwordResetResendKey(c, auth.record));
      re.noContent(204);
    },
  );
}

async function requestEmailChange(e: RequestEvent): Promise<void> {
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

  const event = RecordRequestEmailChangeRequestEvent.from(e, {
    collection: c,
    record: model(c, record),
    newEmail,
  });
  await e.app.hooks.onRecordRequestEmailChangeRequest.trigger(
    event,
    async (re) => {
      try {
        await sendFlowMail(re.app, "emailChange", re.record, re.newEmail);
      } catch (error) {
        throw failed(error, "Failed to request email change.");
      }
      re.noContent(204);
    },
  );
}

function parseEmailChangeToken(
  app: App,
  c: Collection,
  token: string,
): { record: Values; newEmail: string } | FieldIssue {
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

async function confirmEmailChange(e: RequestEvent): Promise<void> {
  const c = findAuthCollection(e);
  if (c.name === "_superusers")
    throw new ApiError(400, "All superusers can change their emails directly.");
  const form = await readForm(e, ["token", "password"]);
  const parsed = parseEmailChangeToken(e.app, c, form.token);
  const passwordError = async () => {
    if (form.password === "") return required;
    if (runeLength(form.password) > 100) return lengthError(1, 100);
    return "record" in parsed &&
      (await verifyPassword(parsed.record.password, form.password))
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

  const tokenKey = parsed.record.tokenKey as string;
  const event = RecordConfirmEmailChangeRequestEvent.from(e, {
    collection: c,
    record: model(c, parsed.record),
    newEmail: parsed.newEmail,
  });
  await e.app.hooks.onRecordConfirmEmailChangeRequest.trigger(
    event,
    async (ce) => {
      ce.record.set("email", ce.newEmail);
      ce.record.set("verified", true);
      await save(
        ce.app,
        ce.record,
        "Failed to confirm email change.",
        tokenKey,
      );
      ce.noContent(204);
    },
  );
}

function requireOtpEnabled(e: RequestEvent): Collection {
  const c = findAuthCollection(e);
  if (!(c.otp as { enabled: boolean }).enabled)
    throw new ApiError(
      403,
      "The collection is not configured to allow OTP authentication.",
    );
  return c;
}

async function requestOtp(e: RequestEvent): Promise<void> {
  const c = requireOtpEnabled(e);
  const { email } = await readForm(e, ["email"]);
  check({ email: emailError(email) });

  const found = findAuthRecordByEmail(e.app, c, email);
  const event = RecordCreateOTPRequestEvent.from(e, {
    collection: c,
    record: found && model(c, found),
    password: generateOtpCode(otpLength(c)),
  });
  await e.app.hooks.onRecordRequestOTPRequest.trigger(event, async (oe) => {
    const { app, record, password } = oe;
    if (!record) {
      // same bcrypt work as a real request, so the response time does not reveal the account
      await Bun.password.hash("0".repeat(8), { algorithm: "bcrypt", cost: 8 });
      oe.json(200, { otpId: newId() });
      throw new ApiError(
        400,
        `missing or invalid ${c.name} OTP auth record with email ${email}`,
      );
    }
    await deleteExpiredOtps(app, c);
    const { id, code } = await issueOtp(app, c, valuesOf(record), password);
    if (code !== null)
      inBackground(app, async () => {
        try {
          await sendOtpMail(app, record, id, code);
        } catch (error) {
          await deleteOtp(app, id);
          app.logger.error("Failed to send OTP email", { error });
        }
      });
    oe.json(200, { otpId: id });
  });
}

async function authWithOtp(e: RequestEvent): Promise<void> {
  const c = requireOtpEnabled(e);
  const body = await loadBody(e);
  const form = await readForm(e, ["otpId", "password"], body);
  check({
    otpId:
      form.otpId === ""
        ? required
        : runeLength(form.otpId) > 255
          ? lengthError(1, 255)
          : null,
    password:
      form.password === ""
        ? required
        : runeLength(form.password) > 71
          ? lengthError(1, 71)
          : null,
  });

  // one generic message for every failure, so ids and accounts can't be enumerated
  const invalid = () => new ApiError(400, "Invalid or expired OTP");
  const otp = findOtp(e.app, form.otpId);
  if (!otp || otp.collectionRef !== c.id) throw invalid();
  if (hasExpired(e.app, otp, otpDurationMs(c))) throw invalid();
  let record: Values;
  try {
    record = internalRecords(e.app, c.name).findRaw(otp.recordRef as string);
  } catch (error) {
    if (error instanceof NotFoundError) throw invalid();
    throw error;
  }

  // OTPs are short digit strings, so an extra limit guards against enumeration (PB)
  try {
    checkRateLimit(e, `@hb_otp_${record.id}`, OTP_ATTEMPTS);
  } catch {
    throw new ApiError(
      429,
      "Too many attempts, please try again later with a new OTP.",
    );
  }
  if (!(await verifyPassword(otp.password, form.password))) throw invalid();

  const event = RecordAuthWithOTPRequestEvent.from(e, {
    collection: c,
    record: model(c, record),
    otp: model(e.app.collections.find("_otps")!, otp),
  });
  await e.app.hooks.onRecordAuthWithOTPRequest.trigger(event, async (oe) => {
    if (!(await deleteOtp(oe.app, oe.otp.id))) throw invalid();
    // the OTP was mailed to the record email, so it proves ownership of it
    const sentTo = oe.otp.get("sentTo") as string;
    const r = oe.record;
    if (
      r.get("verified") !== true &&
      sentTo !== "" &&
      r.get("email") === sentTo
    ) {
      r.set("verified", true);
      // like PB: without MFA a lone OTP login must not leave a guessable password behind
      if (!(r.collection.mfa as { enabled: boolean }).enabled)
        r.set("password", await randomPassword(r.collection));
      try {
        await save(oe.app, r, "Failed to update the verified state.");
      } catch (error) {
        oe.app.logger.error(
          "Failed to update record verified state after successful OTP validation",
          { error },
        );
      }
    }
    await authResponse(
      oe,
      r.collection,
      r,
      newAuthToken(oe.app, r.collection, valuesOf(r)),
      body,
      "otp",
      "otp",
    );
  });
}

// PB apis/record_auth_impersonate.go: a static token (non-refreshable, custom duration), and no MFA (method "").
async function impersonate(e: RequestEvent): Promise<void> {
  requireSuperuser(e);
  const c = e.app.collections.find(e.params.collection!);
  if (c?.type !== "auth")
    throw new ApiError(404, "Missing or invalid auth collection context.");
  let record: Values;
  try {
    record = internalRecords(e.app, c.name).findRaw(e.params.id!);
  } catch (error) {
    if (error instanceof NotFoundError)
      throw new ApiError(404, "The requested resource wasn't found.");
    throw error;
  }
  const body = await loadBody(e);
  const duration = body.duration ?? 0;
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    Math.abs(duration) >= 2 ** 63
  )
    throw new ApiError(400, LOAD_FAILED);
  check({
    duration:
      duration < 0
        ? {
            code: "validation_min_greater_equal_than_required",
            message: "Must be no less than 0.",
            params: { threshold: 0 },
          }
        : null,
  });
  // PB multiplies int64 seconds by time.Second, which wraps; a non-positive result uses the default
  const nanos = BigInt.asIntN(64, BigInt(duration) * 1_000_000_000n);
  const token = newAuthToken(e.app, c, record, {
    duration: nanos > 0n ? Number(nanos / 1_000_000_000n) : undefined,
    refreshable: false,
  });
  await authResponse(e, c, model(c, record), token, body, "default", "");
}

export function registerRecordAuthFlowRoutes(router: Router): void {
  const base = "/api/collections/{collection}";
  const limited = (path: string, action: RouteAction, ...tags: string[]) =>
    router.route(
      "POST",
      `${base}/${path}`,
      action,
      collectionPathRateLimit("collection", ...tags),
    );
  limited("request-verification", requestVerification, "requestVerification");
  limited("confirm-verification", confirmVerification, "confirmVerification");
  limited(
    "request-password-reset",
    requestPasswordReset,
    "requestPasswordReset",
  );
  limited(
    "confirm-password-reset",
    confirmPasswordReset,
    "confirmPasswordReset",
  );
  limited("request-email-change", requestEmailChange, "requestEmailChange");
  limited("confirm-email-change", confirmEmailChange, "confirmEmailChange");
  limited("request-otp", requestOtp, "requestOTP");
  limited("auth-with-otp", authWithOtp, "authWithOTP", "auth");
  router.route("POST", `${base}/impersonate/{id}`, impersonate);
}
