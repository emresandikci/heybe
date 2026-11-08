import type { App } from "../app";
import { ApiError, errorResponse } from "./errors";
import {
  checkBodyLimit,
  checkSuperuserIp,
  cors,
  framable,
  loadAuth,
  securityHeaders,
} from "./middlewares";
import { Router, createEvent, resolveBodyLimit } from "./router";
import { registerBatchRoutes } from "./routes/batch";
import { registerCollectionRoutes } from "./routes/collections";
import { registerFileRoutes } from "./routes/files";
import { registerHealthRoutes } from "./routes/health";
import { registerRecordAuthRoutes } from "./routes/record-auth";
import { registerRecordAuthFlowRoutes } from "./routes/record-auth-flows";
import { registerRecordAuthOAuth2Routes } from "./routes/record-auth-oauth2";
import { registerRecordRoutes } from "./routes/records";
import { registerSettingsRoutes } from "./routes/settings";

// `--http` value: "host:port", ":port" (all interfaces), "[ipv6]:port" or a bare port on 127.0.0.1.
export function parseHttpAddr(addr: string): { host: string; port: number } {
  const match = /^(?:(\[[^\]]*\]|[^:]*):)?(\d{1,5})$/.exec(addr);
  const port = Number(match?.[2]);
  if (!match || port > 65535)
    throw new Error(
      `Invalid --http address "${addr}": expected host:port, :port or a port`,
    );
  const host = match[1];
  if (host === undefined) return { host: "127.0.0.1", port };
  if (host === "") return { host: "0.0.0.0", port };
  return { host: host.replace(/^\[(.*)\]$/, "$1"), port };
}

export function createRouter(): Router {
  const router = new Router();
  registerHealthRoutes(router);
  registerRecordAuthRoutes(router);
  registerRecordAuthFlowRoutes(router);
  registerRecordAuthOAuth2Routes(router);
  registerCollectionRoutes(router);
  registerRecordRoutes(router);
  registerFileRoutes(router);
  registerBatchRoutes(router);
  registerSettingsRoutes(router);
  return router;
}

export function serve(
  app: App,
  opts: { host: string; port: number; origins?: string[]; router?: Router },
): { url: string; stop(): Promise<void> } {
  const router = opts.router ?? createRouter();
  router.add("GET", "/{path...}", () => {
    throw new ApiError(404, "File not found");
  });
  const origins = opts.origins?.length ? opts.origins : ["*"];

  const handle = async (req: Request): Promise<Response> => {
    const c = cors(req, origins);
    if (c.preflight) return c.preflight;
    let res: Response;
    try {
      const path = new URL(req.url).pathname;
      const found = router.match(req.method, path);
      // downloads may wait up to PB_THUMBS_MAX_WAIT in the thumb queue
      if (path.startsWith("/api/files/")) server.timeout(req, 0);
      const bodyLimit = resolveBodyLimit(found, app);
      checkBodyLimit(req, bodyLimit);
      if (!found) throw new ApiError(404, "");
      const event = createEvent(app, req, found.params, bodyLimit);
      event.auth = loadAuth(app, req);
      event.remoteIp = server.requestIP(req)?.address ?? "";
      if (event.auth?.isSuperuser) checkSuperuserIp(app, req, event.remoteIp);
      res = await found.h(event);
    } catch (err) {
      res = errorResponse(err);
    }
    for (const [k, v] of Object.entries(securityHeaders()))
      if (k !== "x-frame-options" || !framable.has(res)) res.headers.set(k, v);
    return c.apply(res);
  };

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    maxRequestBodySize: 2 ** 32 - 1,
    fetch: handle,
  });

  return {
    url: `http://${opts.host}:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
}
