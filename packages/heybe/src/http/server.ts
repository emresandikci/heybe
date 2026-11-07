import type { App } from "../app";
import { ApiError, errorResponse } from "./errors";
import { checkBodyLimit, cors, loadAuth, securityHeaders } from "./middlewares";
import { Router, createEvent } from "./router";
import { registerCollectionRoutes } from "./routes/collections";
import { registerHealthRoutes } from "./routes/health";
import { registerRecordAuthRoutes } from "./routes/record-auth";
import { registerRecordRoutes } from "./routes/records";

export function createRouter(): Router {
  const router = new Router();
  registerHealthRoutes(router);
  registerRecordAuthRoutes(router);
  registerCollectionRoutes(router);
  registerRecordRoutes(router);
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
      checkBodyLimit(req, found?.bodyLimit);
      if (!found) throw new ApiError(404, "");
      const event = createEvent(app, req, found.params, found.bodyLimit);
      event.auth = loadAuth(app, req);
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
