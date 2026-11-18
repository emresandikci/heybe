import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { App } from "../app";
import { ApiError } from "./errors";
import {
  SKIP_SUCCESS_ACTIVITY_LOG_KEY,
  skipSuccessActivityLog,
} from "./middlewares";
import type { RequestEvent, RouteAction, Router } from "./router";

// PB defaultCSP without the OpenStreetMap hosts: the Heybe dashboard has no map.
export const DASHBOARD_CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* data: blob:; connect-src 'self' http://127.0.0.1:*; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";

const CACHE_CONTROL = "max-age=1209600, stale-while-revalidate=86400";
const INDEX = "index.html";

// a dir, or "relative/path" -> readable path ($bunfs in a compiled binary)
export type StaticSource = string | ReadonlyMap<string, string>;

// Port of PB apis.Static: serves the `{path...}` wildcard from source.
export function serveStatic(
  source: StaticSource,
  indexFallback = false,
  gzip = false,
): RouteAction {
  return async (e) => {
    if (e.get(SKIP_SUCCESS_ACTIVITY_LOG_KEY) === undefined)
      e.set(SKIP_SUCCESS_ACTIVITY_LOG_KEY, true);
    const filename = cleanPath((e.params.path ?? "").replace(/^\//, ""));
    const fallback = () =>
      indexFallback && filename !== INDEX
        ? sendFile(e, source, INDEX, gzip)
        : null;

    // Go fs.FS rejects rooted names and names leaving the root
    if (/^\.\.([/\\]|$)/.test(filename) || filename.startsWith("/"))
      return fallback() ?? notFound();
    const isDir = await isDirectory(source, filename);
    if (isDir === null) return fallback() ?? notFound();

    const urlPath = new URL(e.req.url).pathname;
    if (isDir) {
      if (!urlPath.endsWith("/"))
        return e.redirect(301, safeRedirectPath(`${urlPath}/`));
    } else if (urlPath.endsWith("/")) {
      const trimmed = urlPath.replace(/\/+$/, "");
      if (trimmed) return e.redirect(301, safeRedirectPath(trimmed));
    } else if (urlPath.endsWith(INDEX)) {
      return e.redirect(301, safeRedirectPath(urlPath.slice(0, -INDEX.length)));
    }

    try {
      return await sendFile(e, source, filename, gzip);
    } catch (err) {
      const index =
        err instanceof ApiError && err.status === 404 ? fallback() : null;
      if (index) return index;
      throw err;
    }
  };
}

// null when the name does not exist
async function isDirectory(
  source: StaticSource,
  filename: string,
): Promise<boolean | null> {
  if (typeof source === "string") {
    try {
      return (await stat(join(source, filename))).isDirectory();
    } catch {
      return null;
    }
  }
  if (source.has(filename)) return false;
  const prefix = filename === "." ? "" : `${filename}/`;
  for (const key of source.keys()) if (key.startsWith(prefix)) return true;
  return null;
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const gzipped = new Map<
  string,
  { stamp: string; body: Uint8Array<ArrayBuffer> }
>();

async function sendFile(
  e: RequestEvent,
  source: StaticSource,
  filename: string,
  gzip: boolean,
): Promise<Response> {
  if (gzip) e.responseHeaders.append("vary", "Accept-Encoding");
  let path: string;
  let name: string;
  if (typeof source === "string") {
    const root = resolve(source);
    path = resolve(root, `.${sep}${filename}`);
    name = path;
    if (!gzip || !acceptsGzip(e)) return e.fileFS(source, filename);
    if (path !== root && !path.startsWith(root + sep)) return notFound();
    try {
      if ((await stat(path)).isDirectory()) path = join(path, INDEX);
      if (!(await stat(path)).isFile()) return notFound();
    } catch {
      return notFound();
    }
    name = path;
  } else {
    name = (await isDirectory(source, filename))
      ? posix.join(filename, INDEX)
      : filename;
    const mapped = source.get(name);
    if (mapped === undefined) return notFound();
    path = mapped;
    if (!gzip || !acceptsGzip(e)) return e.file(path, name);
  }
  const file = Bun.file(path);
  const type = Bun.file(name).type;
  if (!COMPRESSIBLE.test(type) || e.req.headers.has("range"))
    return e.file(path, name);
  const stamp = `${file.size}\0${file.lastModified}`;
  let entry = gzipped.get(path);
  if (entry?.stamp !== stamp) {
    entry = {
      stamp,
      body: gzipSync(await file.bytes()) as Uint8Array<ArrayBuffer>,
    };
    gzipped.set(path, entry);
  }
  const res = e.blob(200, type, entry.body);
  res.headers.set("content-encoding", "gzip");
  return res;
}

const acceptsGzip = (e: RequestEvent) =>
  (e.req.headers.get("accept-encoding") ?? "").includes("gzip");

const notFound = (): never => {
  throw new ApiError(404, "File not found");
};

// Go filepath.Clean: no trailing slash and "." for an empty path.
function cleanPath(path: string): string {
  const cleaned = posix.normalize(path);
  return cleaned.length > 1 ? cleaned.replace(/\/$/, "") : cleaned;
}

// PB safeRedirectPath: leading `//`, `\\` or `\/` collapse to one slash (no open redirects).
function safeRedirectPath(path: string): string {
  return /^[/\\]{2}/.test(path) ? `/${path.replace(/^[/\\]+/, "")}` : path;
}

export function hasDashboard(app: App): boolean {
  return (
    app.dashboardFiles?.has(INDEX) ?? existsSync(join(app.dashboardDir, INDEX))
  );
}

function dashboardHeaders(cacheRoot: boolean) {
  return (e: RequestEvent) => {
    const h = e.responseHeaders;
    if (!e.app.dev && (cacheRoot || e.params.path) && !h.has("cache-control"))
      h.set("cache-control", CACHE_CONTROL);
    if (!h.has("content-security-policy"))
      h.set("content-security-policy", DASHBOARD_CSP);
    return e.next();
  };
}

// PB apis.Serve: the dashboard is served only when its dist exists.
export function registerDashboard(app: App, router: Router): void {
  if (!hasDashboard(app)) return;
  router
    .get(
      "/_/{path...}",
      serveStatic(app.dashboardFiles ?? app.dashboardDir, false, true),
    )
    .use(dashboardHeaders(false));
}

// Port of PB apis.bindUIExtensions.
export function bindUIExtensions(app: App): void {
  app.onServe(
    (se) => {
      if (!hasDashboard(app)) return se.next();
      const group = se.router.group("/_").use(dashboardHeaders(true));
      const extensions = se.uiExtensions.filter((ext) => {
        if (ext.name && ext.dir) return true;
        se.app.logger.debug("Invalid UI extension configuration", {
          extension: ext,
        });
        return false;
      });
      for (const ext of extensions)
        group.get(`/extensions/${ext.name}/{path...}`, serveStatic(ext.dir));

      // read on every request so changes show without a restart
      group
        .get("/extensions.js", async (e) => {
          const parts: BlobPart[] = [];
          for (const ext of extensions) {
            const main = Bun.file(join(ext.dir, "main.js"));
            if (!(await main.exists())) continue;
            try {
              parts.push(
                "await (async function(){",
                await main.bytes(),
                "})();",
              );
            } catch {
              throw e.internalServerError(
                "An error occurred while generating the main.js extension file",
              );
            }
          }
          const body = await new Blob(parts).bytes();
          return e.blob(200, "text/javascript", body);
        })
        .use(skipSuccessActivityLog());
      return se.next();
    },
    { id: "__hbUIExtensions__", priority: 9999 },
  );
}
