import { parseArgs } from "node:util";
import { createApp } from "./app";
import { runInstaller } from "./http/routes/installer";
import { serve } from "./http/server";

interface Superuser {
  id: string;
}

async function upsertSuperuser(dir: string, email: string, password: string) {
  const app = createApp({ dir });
  try {
    const users = app.records("_superusers");
    const { items } = await users.findMany({ where: { email }, perPage: 1 });
    const existing = items[0] as unknown as Superuser | undefined;
    if (existing) await users.update(existing.id, { password });
    else await users.create({ email, password });
  } finally {
    app.close();
  }
}

function runServe(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      http: { type: "string", default: "127.0.0.1:8090" },
      dir: { type: "string", default: "./heybe_data" },
      origins: { type: "string", multiple: true, default: ["*"] },
      dev: { type: "boolean", default: false },
    },
  });
  const sep = values.http.lastIndexOf(":");
  const host = values.http.slice(0, sep) || "0.0.0.0";
  const port = Number(values.http.slice(sep + 1));
  const origins = values.origins.flatMap((o) => o.split(","));
  const app = createApp({ dir: values.dir });
  const server = serve(app, { host, port, origins });
  console.log(`Server started at ${server.url}`);
  runInstaller(app, server.url).catch((err) =>
    console.warn("Failed to initialize installer", err),
  );

  const shutdown = async () => {
    await server.stop();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runSuperuser(argv: string[]) {
  const [sub, ...rest] = argv;
  if (sub !== "upsert") throw new Error(`Unknown superuser command: ${sub}`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { dir: { type: "string", default: "./heybe_data" } },
  });
  const [email, password] = positionals;
  if (!email || !password)
    throw new Error("Usage: heybe superuser upsert <email> <password>");
  await upsertSuperuser(values.dir, email, password);
}

const [command, ...args] = process.argv.slice(2);
if (command === "serve") runServe(args);
else if (command === "superuser") await runSuperuser(args);
else {
  console.error("Usage: heybe <serve|superuser>");
  process.exit(1);
}
