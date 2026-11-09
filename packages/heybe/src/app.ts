import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { parseCommandArgs } from "./commands/args";
import { migrateCommand } from "./commands/migrate";
import { serveCommand } from "./commands/serve";
import { superuserCommand } from "./commands/superuser";
import { typegenCommand } from "./commands/typegen";
import { CollectionStore } from "./collections/store";
import { CronScheduler } from "./cron/scheduler";
import { registerCronJobs } from "./cron/system";
import { type Db, openDb } from "./db";
import {
  type AppFilesystem,
  appFilesystem,
  localFilesystem,
} from "./files/storage";
import { RecordHooks, bindRecordHooks } from "./extend/record-hooks";
import { Cron } from "./extend/cron";
import { Route } from "./extend/route";
import { BootstrapEvent, TerminateEvent } from "./hooks/events";
import {
  type HookBinders,
  type Hooks,
  createHooks,
  hookBinders,
} from "./hooks/registry";
import { registerSystemHooks } from "./hooks/system";
import { Broker } from "./realtime/broker";
import {
  Migration,
  type MigrationDef,
  migrationDef,
} from "./migrations/migration";
import { bindAutomigrate } from "./migrations/automigrate";
import { registerRealtimeHooks } from "./realtime/broadcast";
import type { Router } from "./http/router";
import { createRouter } from "./http/server";
import { type Mailer, appMailer } from "./mail/mailer";
import { internalRecords } from "./records/internal";
import type { RecordService } from "./records/service";
import { Settings } from "./settings";
import { type Timers, realTimers } from "./timers";
import { formatDate, randomSecret } from "./util";

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

type RouterMethods = Pick<
  Router,
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "head"
  | "options"
  | "any"
  | "group"
  | "use"
>;

export interface App extends HookBinders, RouterMethods {
  /**
   * `query` and `get` run anywhere. Writes go inside `await app.db.write(() => ...)`, which queues
   * them behind the other writes in one transaction: `run` outside it always throws, and the
   * synchronous `tx` throws while another write is open.
   */
  db: Db;
  router: Router;
  hooks: Hooks;
  collections: CollectionStore;
  settings: Settings;
  dataDir: string;
  files: AppFilesystem;
  mailer: Mailer;
  realtime: Broker;
  scheduler: CronScheduler;
  now: () => Date;
  timers: Timers;
  dev: boolean;
  migrationsDir: string;
  automigrate: boolean;
  migrations: MigrationDef[];
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
  cron(schedule: string, fn: (app: App) => unknown): string;
  cron(id: string, schedule: string, fn: (app: App) => unknown): string;
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

let memoryTemplate: string | null = null;
const TOKENS = [
  "authToken",
  "passwordResetToken",
  "emailChangeToken",
  "verificationToken",
  "fileToken",
];

// Memory apps copy one bootstrapped data.db made once per process, with their own timestamps and secrets.
function openMemoryDb(path: string, now: () => Date): Db {
  if (!memoryTemplate) {
    const dir = mkdtempSync(join(tmpdir(), "heybe-template-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    const db = openDb(join(dir, "data.db"));
    new CollectionStore(db, now);
    db.close();
    memoryTemplate = join(dir, "data.db");
  }
  copyFileSync(memoryTemplate, path);
  const db = openDb(path);
  db.tx(() => {
    const date = formatDate(now());
    db.run("UPDATE _collections SET created = ?, updated = ?", [date, date]);
    const auth = db.query<{ id: string; data: string }>(
      "SELECT id, data FROM _collections WHERE type = 'auth'",
    );
    for (const { id, data } of auth) {
      const c = JSON.parse(data);
      for (const key of TOKENS) c[key].secret = randomSecret(50);
      db.run("UPDATE _collections SET data = ? WHERE id = ?", [
        JSON.stringify(c),
        id,
      ]);
    }
  });
  return db;
}

export function createApp(opts: AppOptions = {}): App {
  const argv = opts.argv ?? process.argv.slice(2);
  const flags = globalFlags(argv);
  const dir = opts.dir ?? flags.dir ?? "./heybe_data";
  const memory = dir === "" || dir === ":memory:";
  if (!memory) mkdirSync(dir, { recursive: true });
  const dataDir = memory ? mkdtempSync(join(tmpdir(), "heybe-data-")) : dir;
  const now = opts.now ?? (() => new Date());
  const db = memory
    ? openMemoryDb(join(dataDir, "data.db"), now)
    : openDb(join(dataDir, "data.db"));
  const localFiles = localFilesystem(join(dataDir, "storage"));
  const files = appFilesystem(() => localFiles);
  const collections = new CollectionStore(db, now, files);
  const settings = new Settings(db);
  const hooks = createHooks();
  const router = createRouter();
  const commands = new Map<
    string,
    { run: CommandHandler; description: string }
  >();
  const scheduler = new CronScheduler(opts.timers ?? realTimers, now);
  let cronCount = 0;
  let closed = false;
  let bootstrapped = false;

  // PB app.ClearBootstrap
  const clearBootstrap = async () => {
    if (!bootstrapped) return;
    await hooks.onBootstrapClear.trigger(
      BootstrapEvent.of({ app }),
      async () => {
        if (!closed) await db.write(() => {});
        bootstrapped = false;
        app.close();
      },
    );
  };

  const app = {
    ...hookBinders(hooks),
    db,
    hooks,
    router,
    get: (...a) => router.get(...a),
    post: (...a) => router.post(...a),
    put: (...a) => router.put(...a),
    patch: (...a) => router.patch(...a),
    delete: (...a) => router.delete(...a),
    head: (...a) => router.head(...a),
    options: (...a) => router.options(...a),
    any: (...a) => router.any(...a),
    group: (prefix) => router.group(prefix),
    use: (...mw) => router.use(...mw),
    collections,
    settings,
    dataDir,
    files,
    mailer: { send: (msg) => appMailer(app).send(msg) },
    realtime: new Broker(),
    scheduler,
    now,
    timers: opts.timers ?? realTimers,
    dev: opts.dev ?? flags.dev ?? false,
    migrationsDir:
      opts.migrationsDir ??
      flags.migrationsDir ??
      join(dataDir, "..", "heybe_migrations"),
    automigrate: opts.automigrate ?? flags.automigrate ?? true,
    migrations: [],
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
      hooks.onTerminate.trigger(TerminateEvent.of({ app, isRestart }), () =>
        clearBootstrap(),
      ),
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
      if (app.automigrate) bindAutomigrate(app);
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
    cron: (
      ...args:
        [string, (a: App) => unknown] | [string, string, (a: App) => unknown]
    ) => {
      const [id, schedule, fn] =
        args.length === 2 ? [`cron_${++cronCount}`, ...args] : args;
      scheduler.add(id, schedule, () => fn(app));
      return id;
    },
    register: (...classes: (new () => object)[]) => {
      for (const cls of classes) {
        if (cls.prototype instanceof RecordHooks) {
          bindRecordHooks(app, new cls() as RecordHooks);
          continue;
        }
        if (cls.prototype instanceof Cron) {
          const c = new cls() as Cron;
          const id = c.id || cls.name;
          const run = (a: App) => c.run(a);
          if (id) app.cron(id, c.schedule, run);
          else app.cron(c.schedule, run);
          continue;
        }
        if (cls.prototype instanceof Migration) {
          const m = new cls() as Migration;
          if (!m.file)
            throw new Error(`Migration ${cls.name} requires a file name`);
          app.migrations.push(migrationDef(m.file, m));
          continue;
        }
        if (!(cls.prototype instanceof Route))
          throw new Error(`Unsupported extension class ${cls.name}`);
        const r = new cls() as Route;
        router.route(
          r.method,
          r.path,
          (e) => r.handle(e),
          ...(r.middlewares ?? []),
        );
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
      if (memory) rmSync(dataDir, { recursive: true, force: true });
    },
  } as App;
  collections.app = app;
  settings.app = app;
  registerSystemHooks(app);
  registerRealtimeHooks(app);
  registerCronJobs(app);

  app.command("serve", serveCommand, { description: "Starts the web server" });
  app.command("superuser", superuserCommand, {
    description: "Manage superusers",
  });
  app.command("migrate", (args, a) => migrateCommand(args, a), {
    description: "Executes app DB migration scripts",
  });
  app.command("typegen", typegenCommand, {
    description: "Generates TypeScript types for the collections",
  });
  return app;
}
