import { isIP } from "node:net";
import { join } from "node:path";
import type { App } from "../app";
import {
  AUTOCERT_CACHE_DIR,
  ChallengeStore,
  type TlsCert,
  acmeHttpHandler,
  certificateHosts,
  ensureCertificate,
} from "../http/autocert";
import { runInstaller } from "../http/routes/installer";
import { type ServeHandle, parseHttpAddr, serve } from "../http/server";
import { hasDashboard } from "../http/static";
import { migrationsList } from "../migrations/loader";
import { MigrationsRunner } from "../migrations/runner";
import { writeTypesSafely } from "../typegen";
import { parseCommandArgs } from "./args";
import type { CommandHelp } from "./help";

export const DEFAULT_TYPES_FILE = "./hb-env.d.ts";

const RENEW_CHECK_INTERVAL = 12 * 60 * 60 * 1000;

// PB cmd/serve.go listener defaults
export function serveAddrs(
  domains: string[],
  http?: string,
  https?: string,
): { http?: string; https?: string } {
  if (domains.length)
    return { http: http || "0.0.0.0:80", https: https || "0.0.0.0:443" };
  return { http: http || "127.0.0.1:8090", https: https || undefined };
}

export const serveHelp: CommandHelp = {
  use: "serve [domain(s)]",
  description:
    "Starts the web server (default to 127.0.0.1:8090 if no domain is specified)",
  flags: [
    {
      name: "http",
      type: "string",
      usage:
        "TCP address to listen for the HTTP server\n(if domain args are specified - default to 0.0.0.0:80, otherwise - default to 127.0.0.1:8090)",
    },
    {
      name: "https",
      type: "string",
      usage:
        "TCP address to listen for the HTTPS server\n(if domain args are specified - default to 0.0.0.0:443, otherwise - default to empty string, aka. no TLS)\nThe incoming HTTP traffic also will be auto redirected to the HTTPS version",
    },
    {
      name: "origins",
      type: "strings",
      usage: "CORS allowed domain origins list",
      default: "[*]",
    },
  ],
};

export async function serveCommand(args: string[], app: App): Promise<void> {
  const { values, positionals: domains } = parseCommandArgs(args, {
    http: { type: "string" },
    https: { type: "string" },
    origins: { type: "string", multiple: true },
  });
  const addrs = serveAddrs(
    domains,
    typeof values.http === "string" ? values.http : undefined,
    typeof values.https === "string" ? values.https : undefined,
  );
  const http = addrs.http ? parseHttpAddr(addrs.http) : undefined;
  const https = addrs.https ? parseHttpAddr(addrs.https, "https") : undefined;
  const main = (https ?? http)!;
  // Let's Encrypt rejects IPs, fail before any ACME call
  if (https && !domains.length && isIP(https.host))
    throw new Error(
      `serve --https needs a domain argument: Let's Encrypt cannot issue a certificate for "${https.host}" (e.g. heybe serve example.com)`,
    );
  const { hosts, wwwRedirects } = certificateHosts(domains, main.host);
  const origins = (
    Array.isArray(values.origins) ? values.origins.map(String) : ["*"]
  ).flatMap((o) => o.split(","));
  await new MigrationsRunner(app, await migrationsList(app)).up();
  if (app.dev) {
    app.collections.onChange = () => writeTypesSafely(app, DEFAULT_TYPES_FILE);
    writeTypesSafely(app, DEFAULT_TYPES_FILE);
  }
  let server: ServeHandle;
  let baseUrl: string;
  let stopTls = async () => {};
  if (https) {
    const challenges = new ChallengeStore();
    const redirects = http
      ? Bun.serve({
          hostname: http.host,
          port: http.port,
          fetch: acmeHttpHandler(challenges),
        })
      : undefined;
    const certOpts = {
      cacheDir: join(app.dataDir, AUTOCERT_CACHE_DIR),
      hosts,
      issuer: app.certIssuer,
      challenges,
      now: app.now,
    };
    let served: TlsCert;
    try {
      served = (await ensureCertificate(certOpts)).tls;
      server = await serve(app, {
        ...https,
        origins,
        tls: served,
        wwwRedirects,
      });
    } catch (err) {
      await redirects?.stop(true);
      throw err;
    }
    let stopped = false;
    let renewTimer: unknown;
    const scheduleRenew = () => {
      renewTimer = app.timers.setTimeout(async () => {
        try {
          // compared with the served one so a failed swap is retried on the next check
          const { tls } = await ensureCertificate(certOpts);
          if (tls.cert !== served.cert && !stopped) {
            await server.setCertificate(tls);
            served = tls;
          }
        } catch (error) {
          app.logger.error("Failed to renew the TLS certificate", { error });
        }
        if (!stopped) scheduleRenew();
      }, RENEW_CHECK_INTERVAL);
    };
    scheduleRenew();
    stopTls = async () => {
      stopped = true;
      app.timers.clearTimeout(renewTimer);
      await redirects?.stop(true);
    };
    baseUrl = domains.length ? `https://${domains[0]}` : server.url;
  } else {
    server = await serve(app, { ...http!, origins, wwwRedirects });
    baseUrl = server.url;
  }
  console.log(`Server started at ${baseUrl}`);
  if (hasDashboard(app)) console.log(`> Dashboard: ${baseUrl}/_/`);
  console.log(`> REST API:  ${baseUrl}/api/`);
  const installer = runInstaller(app, baseUrl).catch((error) =>
    app.logger.warn("Failed to initialize installer", { error }),
  );
  // a terminate without a signal, like a restart whose execve failed, also ends serve
  const terminated = Promise.withResolvers<void>();
  app.onTerminate(
    async (e) => {
      for (const client of app.realtime.clients()) client.discard();
      await stopTls();
      await server.stop().catch((err) => console.warn("Failed to stop", err));
      await installer;
      terminated.resolve();
      await e.next();
    },
    { id: "hbGracefulShutdown", priority: -9999 },
  );
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    void terminated.promise.then(onSignal);
  });
}
