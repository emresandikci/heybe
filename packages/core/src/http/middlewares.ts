import type { App } from "../app";
import { authFromToken } from "../auth/tokens";
import { isIP } from "node:net";
import { isIpInList } from "../ip";
import { LogLevel, cutBytes } from "../logs/logger";
import { ApiError, toApiError } from "./errors";
import type { AuthState, Middleware, RequestEvent } from "./router";

export const DEFAULT_MAX_BODY_SIZE = 32 << 20;

// PB apis/middlewares.go ids and priorities (DefaultRateLimitMiddlewarePriority is -1000).
export const ACTIVITY_LOGGER_ID = "hbActivityLogger";
export const ACTIVITY_LOGGER_PRIORITY = -1040;
export const SKIP_SUCCESS_ACTIVITY_LOG_ID = "hbSkipSuccessActivityLog";
export const LOG_META_KEY = "hbLogMeta";
export const SKIP_SUCCESS_ACTIVITY_LOG_KEY = "hbSkipSuccessActivityLog";
export const CORS_ID = "hbCors";
export const CORS_PRIORITY = -1041;
export const PANIC_RECOVER_ID = "hbPanicRecover";
export const PANIC_RECOVER_PRIORITY = -1030;
export const LOAD_AUTH_TOKEN_ID = "hbLoadAuthToken";
export const LOAD_AUTH_TOKEN_PRIORITY = -1020;
export const SUPERUSER_IPS_WHITELIST_ID = "hbSuperuserIPsWhitelist";
export const SUPERUSER_IPS_WHITELIST_PRIORITY = -1015;
export const SECURITY_HEADERS_ID = "hbSecurityHeaders";
export const SECURITY_HEADERS_PRIORITY = -1010;
export const BODY_LIMIT_ID = "hbBodyLimit";
export const BODY_LIMIT_PRIORITY = -990;
export const REQUIRE_GUEST_ONLY_ID = "hbRequireGuestOnly";
export const REQUIRE_AUTH_ID = "hbRequireAuth";
export const REQUIRE_SUPERUSER_AUTH_ID = "hbRequireSuperuserAuth";
export const REQUIRE_SUPERUSER_OR_OWNER_AUTH_ID =
  "hbRequireSuperuserOrOwnerAuth";
export const REQUIRE_SAME_COLLECTION_CONTEXT_AUTH_ID =
  "hbRequireSameCollectionContextAuth";

const ALLOW_METHODS = "GET,HEAD,PUT,PATCH,POST,DELETE";

function originAllowed(origin: string, allowed: string[]): string {
  for (const o of allowed) {
    if (o === "*" || o === origin) return o;
  }
  if (origin.length > 253 + 3 + 5 || !origin.includes("://")) return "";
  for (const pattern of allowed) {
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    if (re.test(origin)) return origin;
  }
  return "";
}

// Port of PB apis/middlewares_cors.go (CORS with AllowOrigins and AllowMethods).
export function cors(allowed: string[]): Middleware {
  return {
    id: CORS_ID,
    priority: CORS_PRIORITY,
    fn: (e) => {
      const headers = e.responseHeaders;
      headers.append("vary", "Origin");
      const origin = e.req.headers.get("origin") ?? "";
      const preflight = e.req.method === "OPTIONS";
      const allowOrigin = origin === "" ? "" : originAllowed(origin, allowed);
      if (allowOrigin === "") return preflight ? e.noContent(204) : e.next();

      headers.set("access-control-allow-origin", allowOrigin);
      if (!preflight) return e.next();

      headers.append("vary", "Access-Control-Request-Method");
      headers.append("vary", "Access-Control-Request-Headers");
      headers.set("access-control-allow-methods", ALLOW_METHODS);
      const requested = e.req.headers.get("access-control-request-headers");
      if (requested) headers.set("access-control-allow-headers", requested);
      return e.noContent(204);
    },
  };
}

const cutStr = (text: string, max: number) =>
  Buffer.byteLength(text) > max ? `${cutBytes(text, max)}...` : text;

function logRequest(e: RequestEvent, started: number, err: unknown): void {
  const { logs } = e.app.settings.current();
  if (logs.maxDays === 0) return;
  if (err === undefined && e.get(SKIP_SUCCESS_ACTIVITY_LOG_KEY) !== undefined)
    return;

  const data: Record<string, unknown> = {
    type: "request",
    execTime: performance.now() - started,
  };
  const meta = e.get(LOG_META_KEY);
  if (meta !== undefined && meta !== null) data.meta = meta;

  const method = cutStr(e.req.method.toUpperCase(), 50);
  const { pathname, search } = new URL(e.req.url);
  const url = cutStr(pathname + search, 3000);
  let status = e.status();
  if (err !== undefined) {
    if (err instanceof ApiError) {
      if (status === 0) status = err.status;
      data.error = err.message;
      data.details = err.data;
    } else data.error = err instanceof Error ? err.message : String(err);
  }
  Object.assign(data, {
    url,
    method,
    status,
    referer: cutStr(e.req.headers.get("referer") ?? "", 2000),
    userAgent: cutStr(e.req.headers.get("user-agent") ?? "", 2000),
    auth: e.auth?.collection.name ?? "",
  });
  if (e.auth && logs.logAuthId) data.authId = e.auth.record.id;
  if (logs.logIP) {
    data.userIP = e.realIp();
    data.remoteIP = e.remoteIp;
  }

  let message = url;
  try {
    message = decodeURIComponent(url);
  } catch {}
  e.app.logger.log(
    err === undefined ? LogLevel.info : LogLevel.error,
    `${method} ${message}`,
    data,
  );
}

// Port of PB apis/middlewares.go activityLogger.
export function activityLogger(): Middleware {
  return {
    id: ACTIVITY_LOGGER_ID,
    priority: ACTIVITY_LOGGER_PRIORITY,
    fn: async (e) => {
      const started = performance.now();
      try {
        await e.next();
      } catch (err) {
        logRequest(e, started, err ?? new Error("unknown error"));
        throw err;
      }
      logRequest(e, started, undefined);
    },
  };
}

export function skipSuccessActivityLog(): Middleware {
  return {
    id: SKIP_SUCCESS_ACTIVITY_LOG_ID,
    fn: (e) => {
      e.set(SKIP_SUCCESS_ACTIVITY_LOG_KEY, true);
      return e.next();
    },
  };
}

export function requireGuestOnly(): Middleware {
  return {
    id: REQUIRE_GUEST_ONLY_ID,
    fn: (e) => {
      if (e.auth)
        throw e.badRequestError("The request can be accessed only by guests.");
      return e.next();
    },
  };
}

const requireAuthFn = (collections: string[]) => (e: RequestEvent) => {
  if (!e.auth)
    throw e.unauthorizedError(
      "The request requires valid record authorization token.",
    );
  if (collections.length > 0 && !collections.includes(e.auth.collection.name))
    throw e.forbiddenError(
      "The authorized record is not allowed to perform this action.",
    );
  return e.next();
};

export function requireAuth(...collections: string[]): Middleware {
  return { id: REQUIRE_AUTH_ID, fn: requireAuthFn(collections) };
}

export function requireSuperuserAuth(): Middleware {
  return { id: REQUIRE_SUPERUSER_AUTH_ID, fn: requireAuthFn(["_superusers"]) };
}

export function requireSuperuserOrOwnerAuth(param = "id"): Middleware {
  return {
    id: REQUIRE_SUPERUSER_OR_OWNER_AUTH_ID,
    fn: (e) => {
      if (!e.auth)
        throw e.unauthorizedError(
          "The request requires superuser or record authorization token.",
        );
      if (e.auth.isSuperuser) return e.next();
      if (e.auth.record.id !== e.params[param])
        throw e.forbiddenError("You are not allowed to perform this request.");
      return e.next();
    },
  };
}

export function requireSameCollectionContextAuth(
  param = "collection",
): Middleware {
  return {
    id: REQUIRE_SAME_COLLECTION_CONTEXT_AUTH_ID,
    fn: (e) => {
      if (!e.auth)
        throw e.unauthorizedError(
          "The request requires valid record authorization token.",
        );
      const collection = e.app.collections.findCached(e.params[param] ?? "");
      if (!collection || collection.id !== e.auth.collection.id)
        throw e.forbiddenError(
          `The request requires auth record from ${e.auth.collection.name} collection.`,
        );
      return e.next();
    },
  };
}

export function panicRecover(): Middleware {
  return {
    id: PANIC_RECOVER_ID,
    priority: PANIC_RECOVER_PRIORITY,
    fn: async (e) => {
      try {
        await e.next();
      } catch (err) {
        throw toApiError(err);
      }
    },
  };
}

export function loadAuthToken(): Middleware {
  return {
    id: LOAD_AUTH_TOKEN_ID,
    priority: LOAD_AUTH_TOKEN_PRIORITY,
    fn: (e) => {
      e.auth ??= loadAuth(e.app, e.req);
      return e.next();
    },
  };
}

export function superuserIPsWhitelist(): Middleware {
  return {
    id: SUPERUSER_IPS_WHITELIST_ID,
    priority: SUPERUSER_IPS_WHITELIST_PRIORITY,
    fn: (e) => {
      if (e.hasSuperuserAuth()) checkSuperuserIp(e.app, e.req, e.remoteIp);
      return e.next();
    },
  };
}

export function securityHeaders(): Middleware {
  return {
    id: SECURITY_HEADERS_ID,
    priority: SECURITY_HEADERS_PRIORITY,
    fn: (e) => {
      const h = e.responseHeaders;
      h.set("x-xss-protection", "1; mode=block");
      h.set("x-content-type-options", "nosniff");
      h.set("x-frame-options", "SAMEORIGIN");
      h.set("cross-origin-opener-policy", "same-origin");
      return e.next();
    },
  };
}

// Port of PB applyBodyLimit: a limit <= 0 disables it.
export function applyBodyLimit(e: RequestEvent, bytes: number): void {
  if (bytes <= 0) return;
  checkBodyLimit(e.req, bytes);
  e.bodyLimit = bytes;
}

export function bodyLimit(bytes: number): Middleware {
  return {
    id: BODY_LIMIT_ID,
    priority: BODY_LIMIT_PRIORITY,
    fn: (e) => {
      applyBodyLimit(e, bytes);
      return e.next();
    },
  };
}

export function checkBodyLimit(
  req: Request,
  limit = DEFAULT_MAX_BODY_SIZE,
): void {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > limit) throw new ApiError(413, "Request entity too large");
}

export async function readLimited(
  req: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  checkBodyLimit(req, limit);
  if (!req.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ApiError(413, "Request entity too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function authTokenFromRequest(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  if (header.length > 7 && header.slice(0, 7).toLowerCase() === "bearer ")
    return header.slice(7);
  return header;
}

export function loadAuth(app: App, req: Request): AuthState | null {
  const token = authTokenFromRequest(req);
  return token === "" ? null : authFromToken(app, token);
}

export function realIp(app: App, req: Request, remote: string): string {
  const { headers, useLeftmostIP } = app.settings.current().trustedProxy;
  for (const name of headers) {
    const ips = (req.headers.get(name) ?? "")
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => isIP(ip) !== 0);
    const picked = useLeftmostIP ? ips[0] : ips.at(-1);
    if (picked) return picked;
  }
  return remote;
}

export function checkSuperuserIp(app: App, req: Request, remote: string): void {
  const { superuserIPs } = app.settings.current();
  if (
    superuserIPs.length > 0 &&
    !isIpInList(superuserIPs, realIp(app, req, remote))
  )
    throw new ApiError(403, "");
}
