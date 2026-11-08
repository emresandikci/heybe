import {
  authWithOAuth2,
  oauth2Meta,
  providerConfigs,
  storeAppleName,
} from "../../auth/oauth2/flow";
import { newAuthToken } from "../../auth/tokens";
import { runeLength } from "../../fields/shared";
import { IP_KEY } from "../../realtime/broadcast";
import { buildRequestInfo } from "../../records/rules";
import { valuesOf } from "../../records/service";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";
import { authResponse, findAuthCollection } from "./record-auth";

type Values = Record<string, unknown>;

const LOAD_FAILED = "An error occurred while loading the submitted data.";
const FAILURE_PATH = "../_/#/auth/oauth2-redirect-failure";
const SUCCESS_PATH = "../_/#/auth/oauth2-redirect-success";
const OAUTH2_TOPIC = "@oauth2";

const isObject = (v: unknown): v is Values =>
  v !== null && typeof v === "object" && !Array.isArray(v);

async function loadBody(e: RequestEvent): Promise<Values> {
  try {
    return await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
}

// PB recordOAuth2LoginForm binding: strings (multipart values as submitted) and an optional object.
function bindForm(body: Values, multipart: boolean) {
  const text = (key: string) => {
    const v = body[key];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (multipart && (typeof v === "number" || typeof v === "boolean"))
      return String(v);
    throw new ApiError(400, LOAD_FAILED);
  };
  const createData = body.createData;
  if (createData !== undefined && createData !== null && !isObject(createData))
    throw new ApiError(400, LOAD_FAILED);
  const redirectURL = text("redirectURL") || text("redirectUrl");
  return {
    provider: text("provider"),
    code: text("code"),
    codeVerifier: text("codeVerifier"),
    redirectURL,
    createData: createData ?? undefined,
  };
}

async function authWithOAuth2Route(e: RequestEvent): Promise<void> {
  const c = findAuthCollection(e);
  if (!(c.oauth2 as { enabled: boolean }).enabled)
    throw new ApiError(
      403,
      "The collection is not configured to allow OAuth2 authentication.",
    );
  const body = await loadBody(e);
  const multipart = (e.req.headers.get("content-type") ?? "").startsWith(
    "multipart/form-data",
  );
  const form = bindForm(body, multipart);

  const errors: Values = {};
  const required = { code: "validation_required", message: "Cannot be blank." };
  if (form.provider === "") errors.provider = required;
  else if (runeLength(form.provider) > 100)
    errors.provider = {
      code: "validation_length_too_long",
      message: "The length must be no more than 100.",
      params: { max: 100, min: 0 },
    };
  else if (!providerConfigs(c).some((p) => p.name === form.provider))
    errors.provider = {
      code: "validation_invalid_provider",
      message: `Provider with name ${form.provider} is missing or is not enabled.`,
      params: { name: form.provider },
    };
  if (form.code === "") errors.code = required;
  if (Object.keys(errors).length > 0)
    throw new ApiError(400, LOAD_FAILED, errors);

  await authWithOAuth2(e, c, form, buildRequestInfo(e, body, "oauth2"), (oe) =>
    authResponse(
      oe,
      c,
      oe.record!,
      newAuthToken(oe.app, c, valuesOf(oe.record!)),
      body,
      "oauth2",
      "oauth2",
      oauth2Meta(oe),
    ),
  );
}

interface RedirectData {
  state: string;
  code: string;
  error: string;
  user: string;
}

// PB oauth2RedirectData binding: the query for GET, the body for POST (`user` only from a form).
async function redirectData(e: RequestEvent): Promise<RedirectData | null> {
  if (e.req.method !== "POST") {
    const q = e.query;
    const get = (k: string) => q.get(k) ?? "";
    return {
      state: get("state"),
      code: get("code"),
      error: get("error"),
      user: "",
    };
  }
  let body: Values;
  try {
    body = await e.body();
  } catch {
    return null;
  }
  const json = (e.req.headers.get("content-type") ?? "").startsWith(
    "application/json",
  );
  const text = (key: string) => {
    let v = body[key];
    if (!json && Array.isArray(v)) v = v[0];
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : null;
  };
  const data = {
    state: text("state"),
    code: text("code"),
    error: text("error"),
    user: json ? "" : text("user"),
  };
  return Object.values(data).includes(null) ? null : (data as RedirectData);
}

// Port of PB oauth2SubscriptionRedirect: forwards the code to the realtime client named by `state`.
async function oauth2Redirect(e: RequestEvent): Promise<Response> {
  const status = e.req.method === "GET" ? 307 : 303;
  const failure = () => e.redirect(status, FAILURE_PATH);
  const data = await redirectData(e);
  if (!data || data.state === "") return failure();
  const client = e.app.realtime.clientById(data.state);
  if (!client || client.isDiscarded() || !client.hasSubscription(OAUTH2_TOPIC))
    return failure();
  try {
    const ip = client.get(IP_KEY);
    if (typeof ip === "string" && ip !== "" && ip !== e.realIp())
      return failure();
    if (data.user !== "" && data.error === "" && data.code !== "")
      storeAppleName(e.app, data.code, data.user);
    const { state, code, error } = data;
    client.send({
      name: OAUTH2_TOPIC,
      data: JSON.stringify(error ? { state, code, error } : { state, code }),
    });
    if (error !== "" || code === "") return failure();
    return e.redirect(status, SUCCESS_PATH);
  } finally {
    client.unsubscribe(OAUTH2_TOPIC);
  }
}

export function registerRecordAuthOAuth2Routes(router: Router): void {
  router.route("GET", "/api/oauth2-redirect", oauth2Redirect);
  router.route("POST", "/api/oauth2-redirect", oauth2Redirect);
  router.route(
    "POST",
    "/api/collections/{collection}/auth-with-oauth2",
    authWithOAuth2Route,
  );
}
