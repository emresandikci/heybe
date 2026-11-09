import type { App } from "../app";
import { ServeEvent } from "../hooks/events";
import { ApiError, errorResponse } from "./errors";
import {
  DEFAULT_MAX_BODY_SIZE,
  bodyLimit,
  cors,
  loadAuthToken,
  panicRecover,
  securityHeaders,
  superuserIPsWhitelist,
} from "./middlewares";
import { type Mux, Router, createEvent } from "./router";
import { registerBatchRoutes } from "./routes/batch";
import { registerCollectionRoutes } from "./routes/collections";
import { registerCronRoutes } from "./routes/crons";
import { registerFileRoutes } from "./routes/files";
import { registerHealthRoutes } from "./routes/health";
import { registerRealtimeRoutes } from "./routes/realtime";
import { registerRecordAuthRoutes } from "./routes/record-auth";
import { registerRecordAuthFlowRoutes } from "./routes/record-auth-flows";
import { registerRecordAuthOAuth2Routes } from "./routes/record-auth-oauth2";
import { registerRecordRoutes } from "./routes/records";
import { registerSettingsRoutes } from "./routes/settings";

const SHUTDOWN_TIMEOUT = 1000;

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

// Port of PB apis.NewRouter (the activity logger and rate limit come with phase 7).
export function createRouter(): Router {
  const router = new Router();
  router.use(
    panicRecover(),
    loadAuthToken(),
    superuserIPsWhitelist(),
    securityHeaders(),
    bodyLimit(DEFAULT_MAX_BODY_SIZE),
  );
  registerHealthRoutes(router);
  registerCronRoutes(router);
  registerRealtimeRoutes(router);
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

export function serveOptions(opts: {
  host: string;
  port: number;
  fetch: (req: Request, server: Bun.Server<unknown>) => Promise<Response>;
}) {
  return {
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    maxRequestBodySize: 2 ** 32 - 1,
    fetch: opts.fetch,
  };
}

async function handle(
  app: App,
  mux: Mux,
  req: Request,
  server: Bun.Server<unknown>,
): Promise<Response> {
  const remoteIp = server.requestIP(req)?.address ?? "";
  const found = mux.match(req.method, new URL(req.url).pathname)!;
  const e = createEvent(app, req, found.params, remoteIp, found.pattern);
  let res: Response;
  try {
    res = await found.run(e);
  } catch (err) {
    res = e.response ?? errorResponse(err);
  }
  return withHeaders(res, e.responseHeaders);
}

// Middleware headers were set before the response in PB: they stay unless the response sets the
// same key, a middleware Content-Type wins (PB setResponseHeaderIfEmpty) and Vary values add up.
function withHeaders(res: Response, headers: Headers): Response {
  if (headers.keys().next().done) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of headers) {
    const own = out.headers.get(k);
    if (k === "vary") out.headers.set(k, own ? `${v}, ${own}` : v);
    else if (k === "content-type" || own === null) out.headers.set(k, v);
  }
  return out;
}

// Port of PB apis.Serve: onServe can change the router, its final action starts the server.
export async function serve(
  app: App,
  opts: { host: string; port: number; origins?: string[]; router?: Router },
): Promise<{ url: string; stop(): Promise<void> }> {
  const router = opts.router ?? app.router;
  router.use(cors(opts.origins?.length ? opts.origins : ["*"]));
  const event = ServeEvent.of({ app, router, server: null });
  await app.hooks.onServe.trigger(event, (e) => {
    if (!e.router.hasRoute("GET", "/{path...}"))
      e.router.get("/{path...}", () => {
        throw new ApiError(404, "File not found");
      });
    const mux = e.router.build();
    e.server = Bun.serve(
      serveOptions({
        host: opts.host,
        port: opts.port,
        fetch: (req, server) => handle(app, mux, req, server),
      }),
    );
  });
  const server = event.server;
  if (!server)
    throw new Error(
      "The OnServe listener was not initialized. Did you forget to call the ServeEvent.next() method?",
    );
  return {
    url: `http://${opts.host}:${server.port}`,
    // like Go's Server.Shutdown: in-flight requests get up to 1 s, then the rest are closed
    stop: async () => {
      let timer: unknown;
      const timeout = new Promise<void>((resolve) => {
        timer = app.timers.setTimeout(resolve, SHUTDOWN_TIMEOUT);
      });
      await Promise.race([server.stop(false), timeout]);
      app.timers.clearTimeout(timer);
      await server.stop(true);
    },
  };
}
