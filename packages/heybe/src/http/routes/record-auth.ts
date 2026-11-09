import { toAst } from "@heybe/query";
import type { App } from "../../app";
import { authTokenFromRequest, checkSuperuserIp, realIp } from "../middlewares";
import { recordAuthOrigin } from "../../auth/alerts";
import { type MfaMethod, checkMfa } from "../../auth/mfa";
import { authMethodsProviders } from "../../auth/oauth2/flow";
import { newAuthToken } from "../../auth/tokens";
import { parseUnverifiedJwt } from "../../auth/jwt";
import { quote, findSingleColumnUniqueIndex } from "../../collections/ddl";
import type { Collection } from "../../collections/model";
import { FilterError, parseFilter } from "../../filter/parse";
import { buildRequestInfo } from "../../records/rules";
import { expandModels } from "../../records/expand";
import { RecordModel } from "../../records/model";
import { valuesOf } from "../../records/service";
import {
  RecordAuthRefreshRequestEvent,
  RecordAuthRequestEvent,
  RecordAuthWithPasswordRequestEvent,
} from "../../hooks/events";
import { ValidationError } from "../../util";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";
import { internalRecords } from "../../records/internal";
import { enrichExpanded, triggerEnrich } from "./records";

type Values = Record<string, unknown>;

interface PasswordAuth {
  enabled: boolean;
  identityFields: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function findAuthCollection(e: RequestEvent): Collection {
  const c = e.app.collections.find(e.params.collection!);
  if (!c) throw new ApiError(404, "Missing or invalid collection context.");
  if (c.type !== "auth")
    throw new ApiError(404, "Missing or invalid auth collection context.");
  return c;
}

function fieldError(
  code: string,
  message: string,
  params?: Record<string, unknown>,
) {
  return params ? { code, message, params } : { code, message };
}

function validate(
  body: Values,
  identityFields: string[],
  multipart: boolean,
): { identity: string; password: string; identityField: string } {
  const errors: Record<string, ReturnType<typeof fieldError>> = {};
  const text = (key: string, allowed?: string[]) => {
    const v = body[key];
    // multipart values come inferred (PB RequestInfo.Body) but PB binds this form from the
    // raw strings; inference only applies when String() gives the raw value back
    const s =
      typeof v === "string"
        ? v
        : multipart && (typeof v === "number" || typeof v === "boolean")
          ? String(v)
          : "";
    if (s === "") {
      if (!allowed)
        errors[key] = fieldError("validation_required", "Cannot be blank.");
      return "";
    }
    if (s.length > 255)
      errors[key] = fieldError(
        "validation_length_out_of_range",
        "The length must be between 1 and 255.",
        { min: 1, max: 255 },
      );
    else if (allowed && !allowed.includes(s))
      errors[key] = fieldError(
        "validation_in_invalid",
        "Must be a valid value.",
      );
    return s;
  };
  const identity = text("identity");
  const password = text("password");
  const identityField = text("identityField", identityFields);
  if (Object.keys(errors).length > 0)
    throw new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      errors,
    );
  return { identity, password, identityField };
}

function findByIdentity(
  app: App,
  c: Collection,
  field: string,
  value: string,
): Values | null {
  const index = findSingleColumnUniqueIndex(c.indexes, field);
  if (!index) throw new Error(`missing ${field} unique index constraint`);
  const nocase = /collate\s+nocase/i.test(index.columnsSql);
  const row = app.db.get<{ id: string }>(
    `SELECT id FROM ${quote(c.name)} WHERE ${quote(field)} = ?${nocase ? " COLLATE NOCASE" : ""} LIMIT 1`,
    [value],
  );
  return row ? internalRecords(app, c.name).findRaw(row.id) : null;
}

function findRecord(
  app: App,
  c: Collection,
  identity: string,
  identityField: string,
  fields: string[],
): Values | null {
  if (identityField) return findByIdentity(app, c, identityField, identity);
  const ordered = [...fields].sort(
    (a, b) => Number(b === "email") - Number(a === "email"),
  );
  for (const name of ordered) {
    if (name === "email" && !EMAIL.test(identity)) continue;
    const found = findByIdentity(app, c, name, identity);
    if (found) return found;
  }
  return null;
}

// `stored` is the value of a password field
export async function verifyPassword(
  stored: unknown,
  password: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(
      password,
      (stored as { hash: string }).hash,
    );
  } catch {
    return false;
  }
}

const dummyHashes = new Map<number, Promise<string>>();

// PB runs the dummy check with the collection's configured password cost.
async function dummyPasswordCheck(
  c: Collection,
  password: string,
): Promise<void> {
  const field = c.fields.find((f) => f.name === "password");
  const cost = Number(field?.cost) > 0 ? Number(field?.cost) : 10;
  let hash = dummyHashes.get(cost);
  if (!hash) {
    hash = Bun.password.hash("dummy-password", { algorithm: "bcrypt", cost });
    dummyHashes.set(cost, hash);
  }
  await Bun.password.verify(password, await hash);
}

function canAuthenticate(
  e: RequestEvent,
  c: Collection,
  id: string,
  body: Values,
  context: string,
): boolean {
  if (e.auth?.isSuperuser) return true;
  const rule = c.authRule;
  if (rule === null || rule === undefined) return false;
  if (rule === "") return true;
  let ruleFilter;
  try {
    ruleFilter = parseFilter(rule as string);
  } catch (err) {
    if (err instanceof FilterError) return false;
    throw err;
  }
  try {
    const { items } = internalRecords(e.app, c.name).query({
      ruleFilter,
      filter: toAst({ id }),
      perPage: 1,
      skipTotal: true,
      request: buildRequestInfo(e, body, context),
    });
    return items.length > 0;
  } catch (err) {
    if (err instanceof FilterError || err instanceof ValidationError)
      return false;
    throw err;
  }
}

// PB ErrMFA: thrown after the 401 mfaId response was written, which the server keeps.
export const ErrMFA = new ApiError(401, "mfa required");

// Port of PB recordAuthResponse: the onRecordAuthRequest hook around MFA, the enrich hooks, the auth
// alert and the response. `meta` is the OAuth2 `meta` of the 200 body.
export async function authResponse(
  e: RequestEvent,
  c: Collection,
  record: RecordModel,
  token: string,
  body: Values,
  context: string,
  method: MfaMethod,
  meta?: unknown,
): Promise<void> {
  if (c.name === "_superusers") checkSuperuserIp(e.app, e.req, e.remoteIp);
  if (!canAuthenticate(e, c, record.id, body, context))
    throw new ApiError(
      403,
      "The request doesn't satisfy the collection requirements to authenticate.",
    );
  const respond = async (
    record: RecordModel,
    token: string,
    method: MfaMethod,
    meta: unknown,
  ) => {
    if (e.response) return;
    const values = valuesOf(record);
    const mfaId = await checkMfa(e, c, values, method, body, context);
    if (mfaId !== null) {
      // like PB, written eagerly and failed, so code after next() sees the extra step
      e.json(401, { mfaId });
      throw ErrMFA;
    }
    // like PB, relations expand as the authenticated record
    const info = {
      ...buildRequestInfo(e, body, context),
      auth: values,
      authCollection: c.name,
    };
    await triggerEnrich(e.app, info, [record], () => {
      if (c.name === "_superusers")
        record.unhide(...c.fields.map((f) => f.name));
      record.ignoreEmailVisibility(true);
      return expandModels(
        e.app,
        c,
        [record],
        (e.query.get("expand") ?? "").split(","),
        info,
        (rc, rels, request) => enrichExpanded(e.app, rc, rels, request),
      );
    });
    if (method !== "" && (c.authAlert as { enabled: boolean }).enabled)
      await recordAuthOrigin(
        e.app,
        c,
        values,
        realIp(e.app, e.req, e.remoteIp),
        e.req.headers.get("user-agent") ?? "",
      ).catch((error) =>
        e.app.logger.error("Failed to record auth origin", { error }),
      );
    e.json(
      200,
      meta === undefined || meta === null
        ? { record, token }
        : { meta, record, token },
    );
  };
  const hook = e.app.hooks.onRecordAuthRequest;
  if (hook.length === 0) return respond(record, token, method, meta);
  const event = RecordAuthRequestEvent.from(e, {
    collection: c,
    record,
    token,
    meta,
    authMethod: method,
  });
  await hook.trigger(event, (ae) =>
    respond(ae.record, ae.token, ae.authMethod as MfaMethod, ae.meta),
  );
}

export function registerRecordAuthRoutes(router: Router): void {
  router.route("GET", "/api/collections/{collection}/auth-methods", (e) => {
    const c = findAuthCollection(e);
    const password = c.passwordAuth as PasswordAuth;
    const otp = c.otp as { enabled: boolean; duration: number };
    const mfa = c.mfa as { enabled: boolean; duration: number };
    const emailPassword =
      password.enabled && password.identityFields.includes("email");
    const usernamePassword =
      password.enabled && password.identityFields.includes("username");
    const oauth2 = (c.oauth2 as { enabled: boolean }).enabled;
    const providers = oauth2 ? authMethodsProviders(c) : [];
    return e.json(200, {
      password: {
        identityFields: password.enabled ? password.identityFields : [],
        enabled: password.enabled,
      },
      oauth2: { providers, enabled: oauth2 },
      mfa: { enabled: mfa.enabled, duration: mfa.enabled ? mfa.duration : 0 },
      otp: {
        enabled: otp.enabled,
        duration: otp.enabled ? otp.duration : 0,
      },
      authProviders: providers.map((p) => ({ ...p, logo: "" })),
      usernamePassword,
      emailPassword,
    });
  });

  router.route(
    "POST",
    "/api/collections/{collection}/auth-with-password",
    async (e) => {
      const c = findAuthCollection(e);
      const password = c.passwordAuth as PasswordAuth;
      if (!password.enabled)
        throw new ApiError(
          403,
          "The collection is not configured to allow password authentication.",
        );
      const body = await e.body().catch((err) => {
        if (err instanceof ApiError && err.status === 413) throw err;
        throw new ApiError(
          400,
          "An error occurred while loading the submitted data.",
        );
      });
      const form = validate(
        body,
        password.identityFields,
        (e.req.headers.get("content-type") ?? "").startsWith(
          "multipart/form-data",
        ),
      );
      const found = findRecord(
        e.app,
        c,
        form.identity,
        form.identityField,
        password.identityFields,
      );
      const login = async (record: RecordModel | null, password: string) => {
        if (
          !record ||
          !(await verifyPassword(record.get("password"), password))
        ) {
          if (!record) await dummyPasswordCheck(c, password);
          throw new ApiError(400, "Failed to authenticate.");
        }
        await authResponse(
          e,
          c,
          record,
          newAuthToken(e.app, c, valuesOf(record)),
          body,
          "password",
          "password",
        );
      };
      const record = found && new RecordModel(c, found, false);
      const hook = e.app.hooks.onRecordAuthWithPasswordRequest;
      if (hook.length === 0) return login(record, form.password);
      const event = RecordAuthWithPasswordRequestEvent.from(e, {
        collection: c,
        record,
        identity: form.identity,
        identityField: form.identityField,
        password: form.password,
      });
      await hook.trigger(event, (pe) => login(pe.record, pe.password));
    },
  );

  router.route(
    "POST",
    "/api/collections/{collection}/auth-refresh",
    async (e) => {
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
      const body = await e.body().catch((err) => {
        if (err instanceof ApiError && err.status === 413) throw err;
        throw new ApiError(
          400,
          "Something went wrong while processing your request.",
        );
      });
      const refresh = (record: RecordModel) => {
        let token = authTokenFromRequest(e.req);
        // impersonate tokens are not refreshable
        const claims = parseUnverifiedJwt(token, e.app.now);
        if (claims?.refreshable === true)
          token = newAuthToken(e.app, c, valuesOf(record));
        return authResponse(e, c, record, token, body, "default", "");
      };
      const record = new RecordModel(c, e.auth.record, false);
      const hook = e.app.hooks.onRecordAuthRefreshRequest;
      if (hook.length === 0) return refresh(record);
      const event = RecordAuthRefreshRequestEvent.from(e, {
        collection: c,
        record,
      });
      await hook.trigger(event, (re) => refresh(re.record));
    },
  );
}
