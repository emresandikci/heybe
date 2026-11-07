import type { App } from "../app";
import { authFromToken } from "../auth/tokens";
import { isIP } from "node:net";
import { isIpInList } from "../ip";
import { ApiError } from "./errors";
import type { AuthState } from "./router";

export const DEFAULT_MAX_BODY_SIZE = 32 << 20;

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

export function cors(
  req: Request,
  allowed: string[],
): { preflight: Response | null; apply(res: Response): Response } {
  const origin = req.headers.get("origin") ?? "";
  const preflight = req.method === "OPTIONS";
  const headers = new Headers({ vary: "Origin" });
  const noContent = () => new Response(null, { status: 204, headers });
  const result = () => ({
    preflight: preflight ? noContent() : null,
    apply: (res: Response) => withHeaders(res, headers),
  });
  if (origin === "") return result();

  const allowOrigin = originAllowed(origin, allowed);
  if (allowOrigin === "") return result();

  headers.set("access-control-allow-origin", allowOrigin);
  if (!preflight) return result();

  headers.append("vary", "Access-Control-Request-Method");
  headers.append("vary", "Access-Control-Request-Headers");
  headers.set("access-control-allow-methods", ALLOW_METHODS);
  const requested = req.headers.get("access-control-request-headers");
  if (requested) headers.set("access-control-allow-headers", requested);
  return result();
}

export function securityHeaders(): Record<string, string> {
  return {
    "x-xss-protection": "1; mode=block",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "cross-origin-opener-policy": "same-origin",
  };
}

export function checkBodyLimit(
  req: Request,
  limit = DEFAULT_MAX_BODY_SIZE,
): void {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > limit) throw new ApiError(413, "Request entity too large");
}

function withHeaders(res: Response, extra: Headers): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of extra) {
    if (k === "vary") out.headers.append(k, v);
    else out.headers.set(k, v);
  }
  return out;
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

function realIp(app: App, req: Request, remote: string): string {
  const { headers, useLeftmostIP } = app.settings.get().trustedProxy;
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
  const { superuserIPs } = app.settings.get();
  if (
    superuserIPs.length > 0 &&
    !isIpInList(superuserIPs, realIp(app, req, remote))
  )
    throw new ApiError(403, "");
}
