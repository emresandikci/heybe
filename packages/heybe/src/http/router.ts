import { stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { App } from "../app";
import type { Collection } from "../collections/model";
import type { RequestInfo } from "../filter/compile";
import { Hook, HookEvent } from "../hooks/hook";
import { pickFields, pickItems } from "../records/serialize";
import { ApiError, logUnexpected, safeErrorsData, statusText } from "./errors";
import { readLimited, realIp } from "./middlewares";
import { parseMultipart } from "./multipart";

export interface AuthState {
  record: Record<string, unknown>;
  collection: Collection;
  isSuperuser: boolean;
}

type Values = Record<string, unknown>;

interface RequestState {
  app: App;
  req: Request;
  params: Record<string, string>;
  pattern: string;
  query: URLSearchParams;
  auth: AuthState | null;
  remoteIp: string;
  response: Response | null;
  responseHeaders: Headers;
  store: Map<string, unknown>;
  bodyLimit: number;
  body?: Promise<Values>;
  info?: Promise<RequestInfo>;
}

// Port of PB core.RequestEvent. Request hook events made with `from` share this state with the
// router event, only `next` and `extra` are their own.
export class RequestEvent extends HookEvent {
  protected readonly state: RequestState;

  constructor(state: RequestState) {
    super();
    this.state = state;
  }

  static from<T extends RequestEvent>(
    this: new (state: RequestState) => T,
    re: RequestEvent,
    fields: Omit<T, keyof RequestEvent>,
  ): T {
    return Object.assign(new this(re.state), fields);
  }

  // PB processInternalRequest: a batch sub-request with its own request, params, request info and
  // response, and the auth and a copy of the store of `re`.
  static internal(
    re: RequestEvent,
    req: Request,
    params: Record<string, string>,
    info: RequestInfo,
  ): RequestEvent {
    return new RequestEvent({
      ...re.state,
      req,
      params,
      pattern: "",
      query: new URL(req.url).searchParams,
      response: null,
      responseHeaders: new Headers(),
      store: new Map(re.state.store),
      body: Promise.resolve(info.body),
      info: Promise.resolve(info),
    });
  }

  get app(): App {
    return this.state.app;
  }
  get req(): Request {
    return this.state.req;
  }
  get params(): Record<string, string> {
    return this.state.params;
  }
  get pattern(): string {
    return this.state.pattern;
  }
  get query(): URLSearchParams {
    return this.state.query;
  }
  get auth(): AuthState | null {
    return this.state.auth;
  }
  set auth(auth: AuthState | null) {
    this.state.auth = auth;
  }
  get remoteIp(): string {
    return this.state.remoteIp;
  }
  set remoteIp(ip: string) {
    this.state.remoteIp = ip;
  }
  get response(): Response | null {
    return this.state.response;
  }
  set response(res: Response | null) {
    this.state.response = res;
  }
  // Headers added to whatever response is sent, error responses included (PB e.Response.Header()).
  get responseHeaders(): Headers {
    return this.state.responseHeaders;
  }
  get bodyLimit(): number {
    return this.state.bodyLimit;
  }
  set bodyLimit(bytes: number) {
    this.state.bodyLimit = bytes;
  }

  status(): number {
    return this.state.response?.status ?? 0;
  }

  written(): boolean {
    return this.state.response !== null;
  }

  isTLS(): boolean {
    return new URL(this.req.url).protocol === "https:";
  }

  // Go's http.Cookie adds Path and SameSite only when set, Bun.Cookie defaults them to "/" and Lax
  setCookie(cookie: Bun.CookieInit): void {
    const value = new Bun.Cookie({ path: "", ...cookie }).serialize();
    this.responseHeaders.append(
      "set-cookie",
      cookie.sameSite ? value : value.replace("; SameSite=Lax", ""),
    );
  }

  getAll(): Record<string, unknown> {
    return Object.fromEntries(this.state.store);
  }

  setAll(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values))
      this.state.store.set(key, value);
  }

  async findUploadedFiles(key: string): Promise<File[]> {
    const value = (await this.body())[key];
    const values = Array.isArray(value) ? value : [value];
    return values
      .filter((v): v is File => v instanceof File)
      .map((f) => new File([f], basename(f.name), { type: f.type }));
  }

  xml(status: number, body: string): Response {
    return this.send(
      new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
        status,
        headers: { "content-type": "application/xml; charset=utf-8" },
      }),
    );
  }

  // Port of PB Event.FileFS: a directory serves its index.html, a missing file is a 404.
  async fileFS(dir: string, filename: string): Promise<Response> {
    const root = resolve(dir);
    let path = resolve(root, `.${sep}${filename}`);
    const notFound = () => this.notFoundError("File not found");
    if (path !== root && !path.startsWith(root + sep)) throw notFound();
    try {
      if ((await stat(path)).isDirectory()) path = join(path, "index.html");
      if (!(await stat(path)).isFile()) throw notFound();
    } catch {
      throw notFound();
    }
    const file = Bun.file(path);
    return this.send(
      new Response(file, { headers: { "content-type": file.type } }),
    );
  }

  private send(res: Response): Response {
    this.state.response = res;
    return res;
  }

  // Port of PB Event.JSON: on 2xx `?fields=` picks from the JSON form of the body, only from
  // `items` for a list result.
  json(status: number, body: unknown): Response {
    const fields = this.query.get("fields");
    if (fields && status >= 200 && status <= 299 && body !== undefined) {
      const isList = listResults.has(body as object);
      body = JSON.parse(JSON.stringify(body));
      if (isList) {
        const items = (body as { items?: unknown }).items;
        if (Array.isArray(items))
          (body as Values).items = pickItems(items as Values[], fields);
      } else if (Array.isArray(body)) body = pickItems(body, fields);
      else if (body !== null && typeof body === "object")
        body = pickFields(body as Values, fields);
    }
    return this.send(jsonResponse(status, body));
  }

  string(status: number, text: string): Response {
    return this.send(
      new Response(text, {
        status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  html(status: number, html: string): Response {
    return this.send(
      new Response(html, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }

  redirect(status: number, url: string): Response {
    if (status < 300 || status > 399)
      throw new ApiError(500, "Invalid redirect status code");
    return this.send(
      new Response(null, { status, headers: { location: url } }),
    );
  }

  noContent(status: number): Response {
    return this.send(new Response(null, { status }));
  }

  blob(status: number, contentType: string, data: Uint8Array): Response {
    return this.send(
      new Response(data as Uint8Array<ArrayBuffer>, {
        status,
        headers: { "content-type": contentType },
      }),
    );
  }

  stream(status: number, contentType: string, body: ReadableStream): Response {
    return this.send(
      new Response(body, { status, headers: { "content-type": contentType } }),
    );
  }

  body(): Promise<Values> {
    return (this.state.body ??= readBody(this.req, this.bodyLimit));
  }

  // Port of PB RequestEvent.RequestInfo: built once per request, the body is read on first use.
  async requestInfo(): Promise<RequestInfo> {
    const info = await (this.state.info ??= this.loadRequestInfo());
    info.auth = this.auth?.record ?? null;
    info.authCollection = this.auth?.collection.name ?? null;
    return info;
  }

  private async loadRequestInfo(): Promise<RequestInfo> {
    let body: Values;
    try {
      body = await this.body();
    } catch (err) {
      if (err instanceof ApiError && err.status === 413) throw err;
      logUnexpected(err);
      throw new ApiError(400, "");
    }
    return buildRequestInfo(this, body);
  }

  realIp(): string {
    return realIp(this.app, this.req, this.remoteIp);
  }

  hasSuperuserAuth(): boolean {
    return this.auth?.isSuperuser === true;
  }

  get(key: string): unknown {
    return this.state.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.state.store.set(key, value);
  }

  error(status: number, message = "", data?: unknown): ApiError {
    return apiError(status, message || statusText(status), data);
  }
  badRequestError(message = "", data?: unknown): ApiError {
    return apiError(400, message, data);
  }
  notFoundError(message = "", data?: unknown): ApiError {
    return apiError(404, message, data);
  }
  forbiddenError(message = "", data?: unknown): ApiError {
    return apiError(403, message, data);
  }
  unauthorizedError(message = "", data?: unknown): ApiError {
    return apiError(401, message, data);
  }
  tooManyRequestsError(message = "", data?: unknown): ApiError {
    return apiError(429, message, data);
  }
  internalServerError(message = "", data?: unknown): ApiError {
    return apiError(500, message, data);
  }
}

const apiError = (status: number, message: string, data: unknown) =>
  new ApiError(status, message, safeErrorsData(data));

const listResults = new WeakSet<object>();

// Marks a list result (PB search.Result) so `e.json` applies `?fields=` to its items only.
export function markListResult<T extends object>(result: T): T {
  listResults.add(result);
  return result;
}

// A JSON response without the `fields` picking of `e.json`, for results that pick their own fields.
export const jsonResponse = (status: number, body: unknown): Response =>
  Response.json(body, {
    status,
    headers: { "content-type": "application/json" },
  });

export function createEvent(
  app: App,
  req: Request,
  params: Record<string, string>,
  remoteIp = "",
  pattern = "",
): RequestEvent {
  return new RequestEvent({
    app,
    req,
    params,
    pattern,
    query: new URL(req.url).searchParams,
    auth: null,
    remoteIp,
    response: null,
    responseHeaders: new Headers(),
    store: new Map(),
    bodyLimit: Infinity,
  });
}

// PB inflector.Snakecase on the canonical header key ("X-Api-Key" -> "x_api_key")
export const headerKey = (name: string) =>
  name
    .split(/[\W_]+/)
    .filter((w) => w !== "")
    .join("_")
    .toLowerCase();

export function buildRequestInfo(
  e: RequestEvent,
  body: Values,
  context = "default",
): RequestInfo {
  const query = new Map<string, string>();
  for (const [k, v] of e.query) if (!query.has(k)) query.set(k, v);
  const headers = new Map<string, string>();
  for (const [k, v] of e.req.headers) headers.set(headerKey(k), v);
  return {
    auth: e.auth?.record ?? null,
    authCollection: e.auth?.collection.name ?? null,
    body,
    query: Object.fromEntries(query),
    headers: Object.fromEntries(headers),
    method: e.req.method,
    context,
  };
}

async function readBody(req: Request, limit: number): Promise<Values> {
  const type = req.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) return parseMultipart(req, limit);
  const bytes = await readLimited(req, limit);
  if (bytes.length === 0) return {};
  try {
    if (type.startsWith("application/json")) {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data !== null && typeof data === "object" && !Array.isArray(data))
        return data as Values;
      throw new Error("not an object");
    }
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const form = await new Response(bytes, {
        headers: { "content-type": type },
      }).formData();
      const out: Values = {};
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

export type RouteAction = (e: RequestEvent) => unknown;

export interface Middleware {
  id?: string;
  priority?: number;
  fn: RouteAction;
}

export type MiddlewareLike = Middleware | RouteAction;

export interface RouteHandle {
  use(...mw: MiddlewareLike[]): RouteHandle;
  unbind(...ids: string[]): RouteHandle;
}

const toMiddleware = (m: MiddlewareLike): Middleware =>
  typeof m === "function" ? { fn: m } : m;

// A returned Response becomes the event response, like the response helpers.
const respond =
  (fn: RouteAction) =>
  async (e: RequestEvent): Promise<void> => {
    const res = await fn(e);
    if (res instanceof Response) e.response = res;
  };

class Bindable {
  readonly middlewares: Middleware[] = [];
  readonly excluded = new Set<string>();

  use(...mw: MiddlewareLike[]): this {
    for (const m of mw.map(toMiddleware)) {
      this.middlewares.push(m);
      if (m.id) this.excluded.delete(m.id);
    }
    return this;
  }

  unbind(...ids: string[]): this {
    for (const id of ids) {
      if (id === "") continue;
      for (let i = this.middlewares.length - 1; i >= 0; i--)
        if (this.middlewares[i].id === id) this.middlewares.splice(i, 1);
      this.unbindChildren(id);
      this.excluded.add(id);
    }
    return this;
  }

  protected unbindChildren(_id: string): void {}
}

class RouteEntry extends Bindable implements RouteHandle {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly action: RouteAction,
  ) {
    super();
  }
}

// Wildcard names do not matter and a trailing `/{name...}` equals a trailing `/` (PB stripWildcard).
const routeKey = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replace(/\{\w+\}/g, "{}").replace(/\/\{\w+\.\.\.\}$/, "/")}`;

// Port of PB tools/router RouterGroup.
export class RouterGroup extends Bindable {
  private readonly children: (RouterGroup | RouteEntry)[] = [];

  protected constructor(
    readonly prefix: string,
    private readonly fullPrefix: string,
    private readonly registered: Set<string>,
  ) {
    super();
  }

  group(prefix: string): RouterGroup {
    const group = new RouterGroup(
      prefix,
      this.fullPrefix + prefix,
      this.registered,
    );
    this.children.push(group);
    return group;
  }

  route(
    method: string,
    path: string,
    action: RouteAction,
    ...mw: MiddlewareLike[]
  ): RouteHandle {
    method = method.toUpperCase();
    const full = this.fullPrefix + path;
    const key = routeKey(method, full);
    if (this.registered.has(key))
      throw new Error(
        `heybe: route ${method || "ANY"} ${full} is already registered`,
      );
    this.registered.add(key);
    const route = new RouteEntry(method, path, action).use(...mw);
    this.children.push(route);
    return route;
  }

  hasRoute(method: string, path: string): boolean {
    return this.registered.has(routeKey(method, this.fullPrefix + path));
  }

  any(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("", path, action, ...mw);
  }
  get(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("GET", path, action, ...mw);
  }
  post(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("POST", path, action, ...mw);
  }
  put(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("PUT", path, action, ...mw);
  }
  patch(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("PATCH", path, action, ...mw);
  }
  delete(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("DELETE", path, action, ...mw);
  }
  head(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("HEAD", path, action, ...mw);
  }
  options(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("OPTIONS", path, action, ...mw);
  }
  search(path: string, action: RouteAction, ...mw: MiddlewareLike[]) {
    return this.route("SEARCH", path, action, ...mw);
  }

  protected override unbindChildren(id: string): void {
    for (const child of this.children) child.unbind(id);
  }

  // Port of PB Router.loadMux: one Hook per route with the global, group and route middlewares.
  protected compile(
    parents: RouterGroup[],
    out: CompiledRoute[],
    prefix: string,
  ): void {
    for (const child of this.children) {
      if (child instanceof RouterGroup) {
        child.compile([...parents, this], out, prefix + child.prefix);
        continue;
      }
      const hook = new Hook<RequestEvent>();
      const bind = (m: Middleware) =>
        hook.bind(respond(m.fn), { id: m.id, priority: m.priority });
      const kept = (m: Middleware, ...levels: Bindable[]) =>
        !m.id || levels.every((l) => !l.excluded.has(m.id!));
      for (const p of parents)
        for (const m of p.middlewares) if (kept(m, p, this, child)) bind(m);
      for (const m of this.middlewares) if (kept(m, this, child)) bind(m);
      for (const m of child.middlewares) bind(m);
      const tokens = parsePattern(prefix + child.path);
      out.push({
        method: child.method,
        tokens,
        rank: tokens.map((t) => RANK[t.kind]),
        pattern: `${child.method ? `${child.method} ` : ""}${prefix + child.path}`,
        hook,
        action: respond(child.action),
      });
    }
  }
}

interface CompiledRoute {
  method: string;
  tokens: Token[];
  rank: number[];
  pattern: string;
  hook: Hook<RequestEvent>;
  action: (e: RequestEvent) => Promise<void>;
}

export interface Match {
  params: Record<string, string>;
  pattern: string;
  // Runs the middlewares and the action; the response is the event response (empty 200 when none).
  run(e: RequestEvent): Promise<Response>;
}

export interface Mux {
  match(method: string, path: string): Match | null;
}

export class Router extends RouterGroup {
  constructor() {
    super("", "", new Set());
  }

  // Port of PB Router.BuildMux: unmatched requests get PB's 404 after the global middlewares.
  build(): Mux {
    if (!this.hasRoute("", "/{path...}"))
      this.any("/{path...}", () => {
        throw new ApiError(404, "");
      });
    const routes: CompiledRoute[] = [];
    this.compile([], routes, "");
    const find = (method: string, path: string) => {
      const parts = path.split("/").slice(1);
      let best: {
        route: CompiledRoute;
        params: Record<string, string>;
        score: number;
      } | null = null;
      for (const route of routes) {
        const score = methodScore(route.method, method);
        if (score < 0) continue;
        const params = matchTokens(route.tokens, parts);
        if (!params) continue;
        if (
          !best ||
          moreSpecific(route.rank, best.route.rank) ||
          (sameRank(route.rank, best.route.rank) && score > best.score)
        )
          best = { route, params, score };
      }
      return best;
    };
    return {
      match: (method, path) => {
        const best = find(method, path);
        // Go ServeMux.matchOrRedirect: "/x" redirects to "/x/" when that is an exact subtree match
        if (!exactMatch(best?.route, path) && !path.endsWith("/")) {
          const slashed = find(method, `${path}/`);
          if (exactMatch(slashed?.route, `${path}/`))
            return {
              params: {},
              pattern: "",
              run: async (e) => redirectToSlash(e),
            };
        }
        if (!best) return null;
        const { route, params } = best;
        return {
          params,
          pattern: route.pattern,
          run: async (e) => {
            await route.hook.trigger(e, route.action);
            return e.response ?? new Response(null);
          },
        };
      },
    };
  }
}

// Go ServeMux: an exact method beats GET for HEAD, which beats a route for any method.
function methodScore(routeMethod: string, method: string): number {
  if (routeMethod === method) return 2;
  if (method === "HEAD" && routeMethod === "GET") return 1;
  return routeMethod === "" ? 0 : -1;
}

// Go ServeMux pattern segments: a literal, `{name}`, `{name...}` (or a trailing `/`) and `{$}`.
type Token =
  | { kind: "literal"; value: string }
  | { kind: "single"; name: string }
  | { kind: "multi"; name: string }
  | { kind: "end" };

const RANK = { literal: 2, single: 1, end: 1, multi: 0 } as const;

function parsePattern(path: string): Token[] {
  const segments = path.split("/").slice(1);
  return segments.map((seg, i): Token => {
    const last = i === segments.length - 1;
    if (last && seg === "") return { kind: "multi", name: "" };
    if (last && seg === "{$}") return { kind: "end" };
    const multi = /^\{(\w+)\.\.\.\}$/.exec(seg);
    if (multi && last) return { kind: "multi", name: multi[1] };
    const single = /^\{(\w+)\}$/.exec(seg);
    if (single) return { kind: "single", name: single[1] };
    return { kind: "literal", value: seg };
  });
}

function matchTokens(
  tokens: Token[],
  parts: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (i >= parts.length) return null;
    if (t.kind === "multi") {
      if (t.name) params[t.name] = parts.slice(i).map(decode).join("/");
      return params;
    }
    if (t.kind === "end")
      return i === parts.length - 1 && parts[i] === "" ? params : null;
    if (t.kind === "single") {
      if (parts[i] === "") return null;
      params[t.name] = decode(parts[i]);
    } else if (t.value !== parts[i]) return null;
  }
  return tokens.length === parts.length ? params : null;
}

// Go exactMatch: a multi wildcard match is exact only when it matched nothing.
function exactMatch(route: CompiledRoute | undefined, path: string): boolean {
  if (!route) return false;
  if (route.tokens.at(-1)?.kind !== "multi") return true;
  return (
    path.endsWith("/") && route.tokens.length === path.split("/").length - 1
  );
}

// Go http.Redirect with 301 to the path plus "/", before any middleware.
function redirectToSlash(e: RequestEvent): Response {
  const url = new URL(e.req.url);
  const location = `${url.pathname}/${url.search}`;
  const headers: Record<string, string> = { location };
  let body: string | null = null;
  if (e.req.method === "GET" || e.req.method === "HEAD") {
    headers["content-type"] = "text/html; charset=utf-8";
    body = `<a href="${Bun.escapeHTML(location)}">Moved Permanently</a>.\n\n`;
  }
  return new Response(body, { status: 301, headers });
}

function moreSpecific(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

const sameRank = (a: number[], b: number[]) =>
  !moreSpecific(a, b) && !moreSpecific(b, a);

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
