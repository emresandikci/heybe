import type { App } from "../app";
import { runInstaller } from "../http/routes/installer";
import { parseHttpAddr, serve } from "../http/server";
import { hasDashboard } from "../http/static";
import { migrationsList } from "../migrations/loader";
import { MigrationsRunner } from "../migrations/runner";
import { writeTypesSafely } from "../typegen";
import { parseCommandArgs } from "./args";
import type { CommandHelp } from "./help";

export const DEFAULT_TYPES_FILE = "./heybe-env.d.ts";

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
  const { values } = parseCommandArgs(args, {
    http: { type: "string" },
    origins: { type: "string", multiple: true },
  });
  const { host, port } = parseHttpAddr(
    typeof values.http === "string" ? values.http : "127.0.0.1:8090",
  );
  const origins = (
    Array.isArray(values.origins) ? values.origins.map(String) : ["*"]
  ).flatMap((o) => o.split(","));
  await new MigrationsRunner(app, await migrationsList(app)).up();
  if (app.dev) {
    app.collections.onChange = () => writeTypesSafely(app, DEFAULT_TYPES_FILE);
    writeTypesSafely(app, DEFAULT_TYPES_FILE);
  }
  const server = await serve(app, { host, port, origins });
  console.log(`Server started at ${server.url}`);
  if (hasDashboard(app)) console.log(`> Dashboard: ${server.url}/_/`);
  console.log(`> REST API:  ${server.url}/api/`);
  const installer = runInstaller(app, server.url).catch((error) =>
    app.logger.warn("Failed to initialize installer", { error }),
  );
  // a terminate without a signal, like a restart whose execve failed, also ends serve
  const terminated = Promise.withResolvers<void>();
  app.onTerminate(
    async (e) => {
      for (const client of app.realtime.clients()) client.discard();
      await server.stop().catch((err) => console.warn("Failed to stop", err));
      await installer;
      terminated.resolve();
      await e.next();
    },
    { id: "pbGracefulShutdown", priority: -9999 },
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
