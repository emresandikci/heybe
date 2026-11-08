import { authWithOAuth2, providerConfigs } from "../../auth/oauth2/flow";
import { newAuthToken } from "../../auth/tokens";
import { runeLength } from "../../fields/shared";
import { buildRequestInfo } from "../../records/rules";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";
import { authResponse, findAuthCollection } from "./record-auth";

type Values = Record<string, unknown>;

const LOAD_FAILED = "An error occurred while loading the submitted data.";
const FAILURE_PATH = "../_/#/auth/oauth2-redirect-failure";

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

async function authWithOAuth2Route(e: RequestEvent): Promise<Response> {
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

  const { record, meta } = await authWithOAuth2(
    e.app,
    c,
    form,
    e.auth,
    buildRequestInfo(e, body, "oauth2"),
  );
  return authResponse(
    e,
    c,
    record,
    newAuthToken(e.app, c, record),
    body,
    "oauth2",
    "oauth2",
    { meta },
  );
}

// PB oauth2SubscriptionRedirect forwards the code to the realtime client named by `state`. Realtime
// comes in phase 4, so no client exists yet and every redirect takes PB's failure path.
function oauth2Redirect(e: RequestEvent): Response {
  return new Response(null, {
    status: e.req.method === "GET" ? 307 : 303,
    headers: { location: FAILURE_PATH },
  });
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
