import type { App } from "../app";
import type { Collection } from "../collections/model";
import { ApiError } from "./errors";
import { DEFAULT_MAX_BODY_SIZE, readLimited } from "./middlewares";
import { parseMultipart } from "./multipart";

export interface AuthState {
  record: Record<string, unknown>;
  collection: Collection;
  isSuperuser: boolean;
}

export interface RequestEvent {
  app: App;
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  auth: AuthState | null;
  remoteIp: string;
  json(status: number, body: unknown): Response;
  body(): Promise<Record<string, unknown>>;
}

export type BodyLimit =
  number | ((app: App, params: Record<string, string>) => number);

export interface RouteOptions {
  bodyLimit?: BodyLimit;
}

export type Handler = (e: RequestEvent) => Response | Promise<Response>;

interface Route {
  method: string;
  segments: string[];
  rank: number[];
  h: Handler;
  opts: RouteOptions;
}

interface Match {
  h: Handler;
  params: Record<string, string>;
  bodyLimit: BodyLimit;
}

const segmentsOf = (path: string) => path.split("/").slice(1);

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, h: Handler, opts: RouteOptions = {}): void {
    const segments = segmentsOf(path);
    this.routes.push({ method, segments, rank: segments.map(rankOf), h, opts });
  }

  match(method: string, path: string): Match | null {
    const parts = segmentsOf(path);
    const wanted = method === "HEAD" ? ["HEAD", "GET"] : [method];
    let best: { route: Route; params: Record<string, string> } | null = null;
    for (const route of this.routes) {
      if (!wanted.includes(route.method)) continue;
      const params = matchSegments(route.segments, parts);
      if (params && (!best || moreSpecific(route.rank, best.route.rank)))
        best = { route, params };
    }
    if (!best) return null;
    return {
      h: best.route.h,
      params: best.params,
      bodyLimit: best.route.opts.bodyLimit ?? DEFAULT_MAX_BODY_SIZE,
    };
  }
}

export function resolveBodyLimit(match: Match | null, app: App): number {
  if (!match) return DEFAULT_MAX_BODY_SIZE;
  const { bodyLimit } = match;
  return typeof bodyLimit === "number"
    ? bodyLimit
    : bodyLimit(app, match.params);
}

function rankOf(segment: string): number {
  if (/^\{\w+\.\.\.\}$/.test(segment)) return 0;
  return /^\{\w+\}$/.test(segment) ? 1 : 2;
}

function moreSpecific(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function matchSegments(
  pattern: string[],
  parts: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i];
    const wildcard = seg.match(/^\{(\w+)\.\.\.\}$/);
    if (wildcard) {
      if (i !== pattern.length - 1) return null;
      params[wildcard[1]] = parts.slice(i).map(decode).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    const param = seg.match(/^\{(\w+)\}$/);
    if (param) params[param[1]] = decode(parts[i]);
    else if (seg !== parts[i]) return null;
  }
  return pattern.length === parts.length ? params : null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function createEvent(
  app: App,
  req: Request,
  params: Record<string, string>,
  bodyLimit = DEFAULT_MAX_BODY_SIZE,
): RequestEvent {
  return {
    app,
    req,
    params,
    query: new URL(req.url).searchParams,
    auth: null,
    remoteIp: "",
    json: (status, body) =>
      Response.json(body, {
        status,
        headers: { "content-type": "application/json" },
      }),
    body: async () => readBody(req, bodyLimit),
  };
}

async function readBody(
  req: Request,
  limit: number,
): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) return parseMultipart(req, limit);
  const bytes = await readLimited(req, limit);
  if (bytes.length === 0) return {};
  try {
    if (type.startsWith("application/json")) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data !== null && typeof data === "object" && !Array.isArray(data))
        return data as Record<string, unknown>;
      throw new Error("not an object");
    }
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const form = await new Response(bytes, {
        headers: { "content-type": type },
      }).formData();
      const out: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        const prev = out[key];
        if (prev === undefined) out[key] = value;
        else if (Array.isArray(prev)) prev.push(value);
        else out[key] = [prev, value];
      }
      return out;
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "");
  }
  throw new ApiError(400, "Unsupported Content-Type");
}
