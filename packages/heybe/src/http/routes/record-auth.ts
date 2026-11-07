import { toAst } from "@heybe/query";
import type { App } from "../../app";
import { authTokenFromRequest } from "../middlewares";
import { newAuthToken } from "../../auth/tokens";
import { parseUnverifiedJwt } from "../../auth/jwt";
import { quote, findSingleColumnUniqueIndex } from "../../collections/ddl";
import type { Collection } from "../../collections/model";
import { FilterError, parseFilter } from "../../filter/parse";
import { serializeRecord } from "../../records/serialize";
import { ValidationError } from "../../util";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";

type Values = Record<string, unknown>;

interface PasswordAuth {
  enabled: boolean;
  identityFields: string[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function findAuthCollection(e: RequestEvent): Collection {
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
): { identity: string; password: string; identityField: string } {
  const errors: Record<string, ReturnType<typeof fieldError>> = {};
  const text = (key: string, allowed?: string[]) => {
    const v = body[key];
    const s = typeof v === "string" ? v : "";
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
  return row ? app.records(c.name).findRaw(row.id) : null;
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

async function verifyPassword(
  record: Values,
  password: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(
      password,
      (record.password as { hash: string }).hash,
    );
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

async function dummyPasswordCheck(password: string): Promise<void> {
  dummyHash ??= Bun.password.hash("dummy-password", {
    algorithm: "bcrypt",
    cost: 10,
  });
  await Bun.password.verify(password, await dummyHash);
}

function canAuthenticate(
  e: RequestEvent,
  c: Collection,
  record: Values,
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
  const headers: Record<string, string> = {};
  for (const [k, v] of e.req.headers)
    headers[k.toLowerCase().replaceAll("-", "_")] = v;
  try {
    const { items } = e.app.records(c.name).query({
      ruleFilter,
      filter: toAst({ id: record.id as string }),
      perPage: 1,
      skipTotal: true,
      request: {
        auth: e.auth?.record ?? null,
        authCollection: e.auth?.collection.name ?? null,
        body,
        query: Object.fromEntries(e.query),
        headers,
        method: e.req.method,
        context,
      },
    });
    return items.length > 0;
  } catch (err) {
    if (err instanceof FilterError || err instanceof ValidationError)
      return false;
    throw err;
  }
}

function authResponse(
  e: RequestEvent,
  c: Collection,
  record: Values,
  token: string,
  body: Values,
  context: string,
): Response {
  if (!canAuthenticate(e, c, record, body, context))
    throw new ApiError(
      403,
      "The request doesn't satisfy the collection requirements to authenticate.",
    );
  return e.json(200, {
    record: serializeRecord(c, record, {
      isSuperuser: c.name === "_superusers",
      isOwner: true,
    }),
    token,
  });
}

export function registerRecordAuthRoutes(router: Router): void {
  router.add("GET", "/api/collections/{collection}/auth-methods", (e) => {
    const c = findAuthCollection(e);
    const password = c.passwordAuth as PasswordAuth;
    const emailPassword =
      password.enabled && password.identityFields.includes("email");
    const usernamePassword =
      password.enabled && password.identityFields.includes("username");
    return e.json(200, {
      password: {
        identityFields: password.enabled ? password.identityFields : [],
        enabled: password.enabled,
      },
      oauth2: { providers: [], enabled: false },
      mfa: { enabled: false, duration: 0 },
      otp: { enabled: false, duration: 0 },
      authProviders: [],
      usernamePassword,
      emailPassword,
    });
  });

  router.add(
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
      const form = validate(body, password.identityFields);
      const record = findRecord(
        e.app,
        c,
        form.identity,
        form.identityField,
        password.identityFields,
      );
      if (!record || !(await verifyPassword(record, form.password))) {
        if (!record) await dummyPasswordCheck(form.password);
        throw new ApiError(400, "Failed to authenticate.");
      }
      return authResponse(
        e,
        c,
        record,
        newAuthToken(e.app, c, record),
        body,
        "password",
      );
    },
  );

  router.add("POST", "/api/collections/{collection}/auth-refresh", (e) => {
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
    let token = authTokenFromRequest(e.req);
    const claims = parseUnverifiedJwt(token, e.app.now);
    if (claims?.refreshable === true)
      token = newAuthToken(e.app, e.auth.collection, e.auth.record);
    return authResponse(e, c, e.auth.record, token, {}, "default");
  });
}
