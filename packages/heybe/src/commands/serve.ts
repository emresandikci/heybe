import type { App } from "../app";
import { runInstaller } from "../http/routes/installer";
import { parseHttpAddr, serve } from "../http/server";
import { migrationsList } from "../migrations/loader";
import { MigrationsRunner } from "../migrations/runner";
import { writeTypesSafely } from "../typegen";
import { parseCommandArgs } from "./args";

export const DEFAULT_TYPES_FILE = "./heybe-env.d.ts";

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
  const installer = runInstaller(app, server.url).catch((err) =>
    console.warn("Failed to initialize installer", err),
  );
  app.onTerminate(
    async (e) => {
      for (const client of app.realtime.clients()) client.discard();
      await server.stop().catch((err) => console.warn("Failed to stop", err));
      await installer;
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
  });
}
