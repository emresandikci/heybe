import type { Env } from "./env.js";
import { HeybeError } from "./error.js";

export interface RequestOptions {
  requestKey?: string | null;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface SendOptions extends RequestOptions {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

export function buildURL(base: string, path: string): string {
  let url = base;
  const location = (globalThis as { location?: Location }).location;
  if (location && !/^https?:\/\//.test(base)) {
    url = location.origin.replace(/\/$/, "");
    if (!base.startsWith("/")) {
      url += location.pathname || "/";
      if (!url.endsWith("/")) url += "/";
    }
    url += base;
  }
  if (path) {
    if (!url.endsWith("/")) url += "/";
    url += path.startsWith("/") ? path.slice(1) : path;
  }
  return url;
}

function queryValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date)
    return encodeURIComponent(value.toISOString().replace("T", " "));
  if (typeof value === "object")
    return encodeURIComponent(JSON.stringify(value));
  return encodeURIComponent(String(value));
}

export function serializeQuery(query: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      const value = queryValue(item);
      if (value !== null) parts.push(`${encodeURIComponent(key)}=${value}`);
    }
  }
  return parts.join("&");
}

function isFile(value: unknown): boolean {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function hasFile(value: unknown): boolean {
  return (Array.isArray(value) ? value : [value]).some(isFile);
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    isFile(body)
  );
}

export function toBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (isRawBody(body)) return body;
  if (typeof body !== "object" || !Object.values(body).some(hasFile))
    return JSON.stringify(body);

  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (typeof value === "object" && !hasFile(value)) {
      form.append("@jsonPayload", JSON.stringify({ [key]: value }));
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value])
      form.append(key, isFile(item) ? (item as Blob) : String(item));
  }
  return form;
}

export function hasAuthorization(headers?: Record<string, string>): boolean {
  return Object.keys(headers ?? {}).some(
    (k) => k.toLowerCase() === "authorization",
  );
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message === "Aborted")
  );
}

export interface SenderConfig {
  url: string;
  lang: string;
  env: Env;
  token: () => string;
  autoCancel: () => boolean;
  beforeSend?: (
    path: string,
    headers?: Record<string, string>,
  ) => Promise<void> | undefined;
}

export function createSender(cfg: SenderConfig) {
  const controllers = new Map<string, AbortController>();

  function cancelRequest(key: string): void {
    controllers.get(key)?.abort();
    controllers.delete(key);
  }

  function cancelAllRequests(): void {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  }

  async function send<T>(path: string, opts: SendOptions = {}): Promise<T> {
    const pending = cfg.beforeSend?.(path, opts.headers);
    if (pending) await pending;
    const method = opts.method ?? "GET";
    let url = buildURL(cfg.url, path);
    const query = opts.query ? serializeQuery(opts.query) : "";
    if (query) url += (url.includes("?") ? "&" : "?") + query;

    const body = toBody(opts.body);
    const headers = new Headers(opts.headers);
    if (
      !headers.has("Content-Type") &&
      !isRawBody(opts.body) &&
      !(body instanceof FormData)
    )
      headers.set("Content-Type", "application/json");
    if (!headers.has("Accept-Language"))
      headers.set("Accept-Language", cfg.lang);
    const token = cfg.token();
    if (token && !headers.has("Authorization"))
      headers.set("Authorization", token);

    let signal = opts.signal;
    let key = "";
    let controller: AbortController | undefined;
    const forwardAbort = () => controller?.abort();
    if (cfg.autoCancel() && opts.requestKey !== null) {
      key = opts.requestKey || method + path.split("?")[0];
      cancelRequest(key);
      controller = new AbortController();
      controllers.set(key, controller);
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", forwardAbort, { once: true });
      signal = controller.signal;
    }

    const fetch = cfg.env.fetch;
    try {
      const res = await fetch(url, { method, headers, body, signal });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {}
      if (res.status >= 400)
        throw new HeybeError({
          url: res.url || url,
          status: res.status,
          response: data,
        });
      return data as T;
    } catch (err) {
      if (err instanceof HeybeError) throw err;
      throw new HeybeError({
        url,
        isAbort: !!signal?.aborted || isAbortError(err),
        cause: err,
      });
    } finally {
      opts.signal?.removeEventListener("abort", forwardAbort);
      if (controller && controllers.get(key) === controller)
        controllers.delete(key);
    }
  }

  return { send, cancelRequest, cancelAllRequests };
}
