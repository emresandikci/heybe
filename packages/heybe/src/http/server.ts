import type { App } from "../app";
import { ApiError, errorResponse } from "./errors";
import {
  checkBodyLimit,
  checkSuperuserIp,
  cors,
  loadAuth,
  securityHeaders,
} from "./middlewares";
import { Router, createEvent, resolveBodyLimit } from "./router";
import { registerCollectionRoutes } from "./routes/collections";
import { registerHealthRoutes } from "./routes/health";
import { registerRecordAuthRoutes } from "./routes/record-auth";
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
  registerCollectionRoutes(router);
  registerRecordRoutes(router);
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
      const bodyLimit = resolveBodyLimit(found, app);
      checkBodyLimit(req, bodyLimit);
      if (!found) throw new ApiError(404, "");
      const event = createEvent(app, req, found.params, bodyLimit);
      event.auth = loadAuth(app, req);
      if (event.auth?.isSuperuser)
        checkSuperuserIp(app, req, server.requestIP(req)?.address ?? "");
      res = await found.h(event);
    } catch (err) {
      res = errorResponse(err);
    }
    for (const [k, v] of Object.entries(securityHeaders()))
      res.headers.set(k, v);
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
