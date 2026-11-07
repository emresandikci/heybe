import type { App } from "../app";
import { ApiError, errorResponse } from "./errors";
import { checkBodyLimit, cors, securityHeaders } from "./middlewares";
import { Router, createEvent } from "./router";
import { registerHealthRoutes } from "./routes/health";

export function createRouter(): Router {
  const router = new Router();
  registerHealthRoutes(router);
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
      res = await found.h(createEvent(app, req, found.params, found.bodyLimit));
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
