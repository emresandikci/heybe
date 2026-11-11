import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
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
): RouteAction {
  return async (e) => {
    if (e.get(SKIP_SUCCESS_ACTIVITY_LOG_KEY) === undefined)
      e.set(SKIP_SUCCESS_ACTIVITY_LOG_KEY, true);
    const filename = cleanPath((e.params.path ?? "").replace(/^\//, ""));
    const fallback = () =>
      indexFallback && filename !== INDEX ? sendFile(e, source, INDEX) : null;

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
      return await sendFile(e, source, filename);
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

async function sendFile(
  e: RequestEvent,
  source: StaticSource,
  filename: string,
): Promise<Response> {
  if (typeof source === "string") return e.fileFS(source, filename);
  const key = (await isDirectory(source, filename))
    ? posix.join(filename, INDEX)
    : filename;
  const path = source.get(key);
  if (path === undefined) return notFound();
  return e.file(path, key);
}

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
    .get("/_/{path...}", serveStatic(app.dashboardFiles ?? app.dashboardDir))
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
    { id: "__pbUIExtensions__", priority: 9999 },
  );
}
