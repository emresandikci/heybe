import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { parseCommandArgs } from "./commands/args";
import { serveCommand } from "./commands/serve";
import { superuserCommand } from "./commands/superuser";
import { typegenCommand } from "./commands/typegen";
import { CollectionStore } from "./collections/store";
import { type Db, openDb } from "./db";
import { type Filesystem, localFilesystem } from "./files/storage";
import { BootstrapEvent, TerminateEvent } from "./hooks/events";
import {
  type HookBinders,
  type Hooks,
  createHooks,
  hookBinders,
} from "./hooks/registry";
import { type Mailer, mailerFromSettings } from "./mail/mailer";
import { internalRecords } from "./records/internal";
import type { RecordService } from "./records/service";
import { Settings } from "./settings";
import { type Timers, realTimers } from "./timers";

export interface AppOptions {
  dir?: string;
  dev?: boolean;
  migrationsDir?: string;
  automigrate?: boolean;
  now?: () => Date;
  timers?: Timers;
  argv?: string[];
}

export type CommandHandler = (args: string[], app: App) => unknown;

export interface App extends HookBinders {
  db: Db;
  hooks: Hooks;
  collections: CollectionStore;
  settings: Settings;
  files: Filesystem;
  mailer: Mailer;
  now: () => Date;
  timers: Timers;
  dev: boolean;
  migrationsDir: string;
  automigrate: boolean;
  records<N extends CollectionName>(name: N): RecordService<Collections[N]>;
  records(name: string): RecordService<Record<string, unknown>>;
  bootstrap(): Promise<void>;
  terminate(isRestart?: boolean): Promise<void>;
  command(
    name: string,
    run: CommandHandler,
    opts?: { description?: string },
  ): void;
  start(): Promise<number>;
  register(...classes: (new () => object)[]): void;
  close(): void;
}

const FALSE_VALUES = ["0", "f", "F", "false", "FALSE", "False"];
const TRUE_VALUES = ["1", "t", "T", "true", "TRUE", "True"];

function globalFlags(argv: string[]) {
  const { values, tokens } = parseCommandArgs(argv, {});
  const automigrate = tokens?.findLast(
    (t) => t.kind === "option" && t.name === "automigrate",
  );
  const raw = automigrate?.kind === "option" ? automigrate.value : undefined;
  return {
    dir: typeof values.dir === "string" ? values.dir : undefined,
    dev: values.dev === true ? true : undefined,
    migrationsDir:
      typeof values.migrationsDir === "string"
        ? values.migrationsDir
        : undefined,
    automigrate: !automigrate
      ? undefined
      : raw === undefined || TRUE_VALUES.includes(raw)
        ? true
        : FALSE_VALUES.includes(raw)
          ? false
          : undefined,
  };
}

export function createApp(opts: AppOptions = {}): App {
  const argv = opts.argv ?? process.argv.slice(2);
  const flags = globalFlags(argv);
  const dir = opts.dir ?? flags.dir ?? "./heybe_data";
  const memory = dir === "" || dir === ":memory:";
  if (!memory) mkdirSync(dir, { recursive: true });
  const storageRoot = memory
    ? mkdtempSync(join(tmpdir(), "heybe-storage-"))
    : join(dir, "storage");
  const db = openDb(join(memory ? storageRoot : dir, "data.db"));
  const now = opts.now ?? (() => new Date());
  const files = localFilesystem(storageRoot);
  const collections = new CollectionStore(db, now, files);
  const settings = new Settings(db);
  const hooks = createHooks();
  const commands = new Map<
    string,
    { run: CommandHandler; description: string }
  >();
  let closed = false;
  let bootstrapped = false;

  const app = {
    ...hookBinders(hooks),
    db,
    hooks,
    collections,
    settings,
    files,
    mailer: { send: (msg) => mailerFromSettings(settings.get()).send(msg) },
    now,
    timers: opts.timers ?? realTimers,
    dev: opts.dev ?? flags.dev ?? false,
    migrationsDir:
      opts.migrationsDir ??
      flags.migrationsDir ??
      join(memory ? storageRoot : dir, "..", "heybe_migrations"),
    automigrate: opts.automigrate ?? flags.automigrate ?? true,
    records: (name: string): RecordService<Record<string, unknown>> => {
      const r = internalRecords(app, name);
      return {
        findMany: (args) => r.findMany(args),
        findOne: (id, opts) => r.findOne(id, opts),
        create: (data) => r.create(data),
        update: (id, data) => r.update(id, data),
        delete: (id) => r.delete(id),
      };
    },
    bootstrap: async () => {
      if (bootstrapped) return;
      bootstrapped = true;
      await hooks.onBootstrap.trigger(BootstrapEvent.of({ app }), () =>
        settings.reload(),
      );
    },
    terminate: (isRestart = false) =>
      hooks.onTerminate.trigger(TerminateEvent.of({ app, isRestart }), () => {
        bootstrapped = false;
        app.close();
      }),
    command: (name, run, opts) => {
      if (commands.has(name))
        throw new Error(`Command "${name}" is already registered`);
      commands.set(name, { run, description: opts?.description ?? "" });
    },
    start: async () => {
      const { tokens } = parseCommandArgs(argv, {});
      const first = tokens?.find((t) => t.kind === "positional");
      const command = first && commands.get(first.value);
      if (!command) {
        const lines = [...commands].map(
          ([name, c]) => `  ${name.padEnd(12)}${c.description}`,
        );
        console.error(
          `Usage: heybe <command>\n\nCommands:\n${lines.join("\n")}`,
        );
        app.close();
        return 1;
      }
      let code = 0;
      try {
        await app.bootstrap();
        await command.run(
          argv.filter((_, i) => i !== first.index),
          app,
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        code = 1;
      }
      try {
        await app.terminate();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        code = 1;
      } finally {
        app.close();
      }
      return code;
    },
    register: (...classes: (new () => object)[]) => {
      for (const cls of classes)
        throw new Error(`Unsupported extension class ${cls.name}`);
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
      if (memory) rmSync(storageRoot, { recursive: true, force: true });
    },
  } as App;

  app.command("serve", serveCommand, { description: "Starts the web server" });
  app.command("superuser", superuserCommand, {
    description: "Manage superusers",
  });
  app.command("typegen", typegenCommand, {
    description: "Generates TypeScript types for the collections",
  });
  return app;
}
