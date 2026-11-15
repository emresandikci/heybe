import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import pkg from "../package.json" with { type: "json" };
import { parseCommandArgs } from "./commands/args";
import { type CommandHelp, printsOnly, routeArgv } from "./commands/help";
import { importCommand, importHelp } from "./commands/import";
import { migrateCommand, migrateHelp } from "./commands/migrate";
import { serveCommand, serveHelp } from "./commands/serve";
import { superuserCommand, superuserHelp } from "./commands/superuser";
import { typegenCommand, typegenHelp } from "./commands/typegen";
import { registerAutoBackup } from "./backups/auto";
import { LOCAL_TEMP_DIR, createBackup } from "./backups/create";
import { restoreBackup } from "./backups/restore";
import { CollectionStore } from "./collections/store";
import { CronScheduler } from "./cron/scheduler";
import { registerCronJobs } from "./cron/system";
import { type Db, openDb } from "./db";
import { openAuxDb } from "./logs/aux-db";
import { type Logger, createLogger } from "./logs/logger";
import { s3Filesystem } from "./files/s3";
import {
  type AppFilesystem,
  type Filesystem,
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
import {
  AUTOCERT_CACHE_DIR,
  type CertIssuer,
  LETS_ENCRYPT_DIRECTORY,
  acmeIssuer,
} from "./http/autocert";
import { createRouter } from "./http/server";
import { bindUIExtensions } from "./http/static";
import { type Mailer, appMailer } from "./mail/mailer";
import { internalRecords } from "./records/internal";
import type { RecordService } from "./records/service";
import { type S3Config, Settings } from "./settings";
import { type Timers, realTimers } from "./timers";
import { formatDate, randomSecret } from "./util";

export interface AppOptions {
  dir?: string;
  dev?: boolean;
  dashboardDir?: string;
  // embedded dashboard of a compiled binary, served instead of dashboardDir
  dashboardFiles?: ReadonlyMap<string, string>;
  migrationsDir?: string;
  automigrate?: boolean;
  now?: () => Date;
  timers?: Timers;
  certIssuer?: CertIssuer;
  argv?: string[];
  execve?: (
    path: string,
    args: string[],
    env: Record<string, string | undefined>,
  ) => void;
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
  // <dataDir>/auxiliary.db with PB's _logs table
  auxDb: Db;
  logger: Logger;
  router: Router;
  hooks: Hooks;
  collections: CollectionStore;
  settings: Settings;
  dataDir: string;
  files: AppFilesystem;
  // S3 when settings.backups.s3 is enabled, else <dataDir>/backups
  newBackupsFilesystem(): Filesystem;
  mailer: Mailer;
  realtime: Broker;
  scheduler: CronScheduler;
  now: () => Date;
  timers: Timers;
  // obtains the `serve --https` certificate, Let's Encrypt by default
  certIssuer: CertIssuer;
  dev: boolean;
  dashboardDir: string;
  dashboardFiles: ReadonlyMap<string, string> | null;
  migrationsDir: string;
  automigrate: boolean;
  migrations: MigrationDef[];
  records<N extends CollectionName>(name: N): RecordService<Collections[N]>;
  records(name: string): RecordService<Record<string, unknown>>;
  bootstrap(): Promise<void>;
  terminate(isRestart?: boolean): Promise<void>;
  // PB Restart: re-executes the process; a failed execve bootstraps the app again and rethrows
  restart(): Promise<void>;
  createBackup(name?: string): Promise<void>;
  restoreBackup(name: string): Promise<void>;
  // the name of the running backup or restore (PB store key "@activeBackup")
  readonly activeBackup: string | null;
  command(
    name: string,
    run: CommandHandler,
    opts?: Partial<Omit<CommandHelp, "use">> & { use?: string },
  ): void;
  start(): Promise<number>;
  cron(schedule: string, fn: (app: App) => unknown): string;
  cron(id: string, schedule: string, fn: (app: App) => unknown): string;
  register(...classes: (new () => object)[]): void;
  close(): void;
}

const FALSE_VALUES = ["0", "f", "F", "false", "FALSE", "False"];
const TRUE_VALUES = ["1", "t", "T", "true", "TRUE", "True"];

function logStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

// local unless the config is enabled, one S3 client per distinct config
function s3Switch(local: Filesystem, config: () => Readonly<S3Config>) {
  let last: Readonly<S3Config> | null = null;
  let key = "";
  let s3: Filesystem | null = null;
  return (): Filesystem => {
    const c = config();
    if (!c.enabled) return local;
    if (c === last && s3) return s3;
    last = c;
    const k = JSON.stringify(c);
    if (k !== key || !s3) {
      key = k;
      s3 = s3Filesystem(c);
    }
    return s3;
  };
}

// A compiled binary sees ["bun", "/$bunfs/root/<name>", ...args]; re-executing that argv
// would pass the entry twice.
export function restartArgv(argv: string[]): string[] {
  const entry = argv[1] ?? "";
  return entry.startsWith("/$bunfs/") || entry.startsWith("B:/~BUN/")
    ? [argv[0]!, ...argv.slice(2)]
    : argv;
}

const BUILTIN_COMMANDS = [
  ["serve", serveCommand, serveHelp],
  ["superuser", superuserCommand, superuserHelp],
  ["migrate", (args, a) => migrateCommand(args, a), migrateHelp],
  ["typegen", typegenCommand, typegenHelp],
  ["import", importCommand, importHelp],
] as const satisfies [string, CommandHandler, CommandHelp][];

// help and version leave the data dir untouched, like PB; an empty argv keeps it for
// programmatic use
function printsHelp(argv: string[]): boolean {
  const help = BUILTIN_COMMANDS.map(([name, , h]) => ({
    ...h,
    use: h.use ?? name,
  }));
  return (
    argv.length > 0 &&
    (printsOnly(argv) || routeArgv(argv, help, pkg.version).type === "print")
  );
}

export function createApp(opts: AppOptions = {}): App {
  const argv = opts.argv ?? process.argv.slice(2);
  const flags = globalFlags(argv);
  const dir = opts.dir ?? flags.dir ?? "./heybe_data";
  const memory = dir === "" || dir === ":memory:" || printsHelp(argv);
  if (!memory) mkdirSync(dir, { recursive: true });
  const dataDir = memory ? mkdtempSync(join(tmpdir(), "heybe-data-")) : dir;
  const now = opts.now ?? (() => new Date());
  const db = memory
    ? openMemoryDb(join(dataDir, "data.db"), now)
    : openDb(join(dataDir, "data.db"));
  const auxDb = openAuxDb(join(dataDir, "auxiliary.db"));
  const settings = new Settings(db);
  const files = appFilesystem(
    s3Switch(
      localFilesystem(join(dataDir, "storage")),
      () => settings.current().s3,
    ),
  );
  const backupsFiles = s3Switch(
    localFilesystem(join(dataDir, "backups")),
    () => settings.current().backups.s3,
  );
  const collections = new CollectionStore(db, now, files);
  const hooks = createHooks();
  const router = createRouter();
  const commands = new Map<
    string,
    { run: CommandHandler; help: CommandHelp }
  >();
  const scheduler = new CronScheduler(opts.timers ?? realTimers, now, (m, d) =>
    app.logger.warn(m, d),
  );
  let cronCount = 0;
  let closed = false;
  let bootstrapped = false;
  let activeBackup: string | null = null;
  const execve = opts.execve ?? ((...args) => process.execve!(...args));

  // PB app.ClearBootstrap; a restart keeps the handles open until execve
  const clearBootstrap = async (close = true) => {
    if (!bootstrapped) return;
    await hooks.onBootstrapClear.trigger(
      BootstrapEvent.of({ app }),
      async () => {
        bootstrapped = false;
        if (!closed) await db.write(() => {});
        if (close) app.close();
      },
    );
  };

  // A failed restart bootstraps again without removing the temp dir, which holds the data a
  // failed restore moves back.
  const bootstrap = async (removeTemp: boolean) => {
    if (bootstrapped) return;
    bootstrapped = true;
    await hooks.onBootstrap.trigger(BootstrapEvent.of({ app }), async () => {
      await settings.reload();
      if (removeTemp)
        await rm(join(dataDir, LOCAL_TEMP_DIR), {
          recursive: true,
          force: true,
        });
    });
  };

  // `revert` runs before the bootstrap that follows a failed execve
  const restart = async (revert?: () => Promise<void>) => {
    if (process.platform === "win32")
      throw new Error("restart is not supported on windows");
    await hooks.onTerminate.trigger(
      TerminateEvent.of({ app, isRestart: true }),
      async () => {
        await clearBootstrap(false).catch(() => {});
        try {
          execve(process.execPath, restartArgv(process.argv), process.env);
        } catch (err) {
          await revert?.();
          await bootstrap(false).catch((error) =>
            app.logger.error(
              "Failed to rebootstrap the application after failed app.Restart()",
              { error },
            ),
          );
          throw err;
        }
      },
    );
  };

  const backupOperation = async (name: string, run: () => Promise<void>) => {
    if (activeBackup !== null)
      throw new Error(
        "try again later - another backup/restore operation has already been started",
      );
    activeBackup = name;
    try {
      await run();
    } finally {
      activeBackup = null;
    }
  };

  const app = {
    ...hookBinders(hooks),
    db,
    auxDb,
    logger: null!, // createLogger below needs the app
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
    newBackupsFilesystem: backupsFiles,
    mailer: { send: (msg) => appMailer(app).send(msg) },
    realtime: new Broker(),
    scheduler,
    now,
    timers: opts.timers ?? realTimers,
    certIssuer:
      opts.certIssuer ??
      acmeIssuer({
        directoryUrl: LETS_ENCRYPT_DIRECTORY,
        accountKeyPath: join(dataDir, AUTOCERT_CACHE_DIR, "account.pem"),
      }),
    dev: opts.dev ?? flags.dev ?? false,
    dashboardDir: opts.dashboardDir ?? resolve(import.meta.dir, "../ui/dist"),
    dashboardFiles: opts.dashboardFiles ?? null,
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
    bootstrap: () => bootstrap(true),
    terminate: (isRestart = false) =>
      hooks.onTerminate.trigger(TerminateEvent.of({ app, isRestart }), () =>
        clearBootstrap(),
      ),
    restart: () => restart(),
    createBackup: (name = "") =>
      backupOperation(name, () => createBackup(app, name)),
    restoreBackup: (name) =>
      backupOperation(name, () => restoreBackup(app, name, restart)),
    get activeBackup() {
      return activeBackup;
    },
    command: (name, run, opts) => {
      if (commands.has(name))
        throw new Error(`Command "${name}" is already registered`);
      commands.set(name, {
        run,
        help: { description: "", ...opts, use: opts?.use ?? name },
      });
    },
    start: async () => {
      const route = routeArgv(
        argv,
        [...commands.values()].map((c) => c.help),
        pkg.version,
      );
      if (route.type !== "run") {
        if (route.type === "print") process.stdout.write(route.text);
        else console.error(`${logStamp(app.now())} ${route.message}`);
        app.close();
        return route.type === "print" ? 0 : 1;
      }
      const command = commands.get(route.name)!;
      if (app.automigrate) bindAutomigrate(app);
      let code = 0;
      try {
        await app.bootstrap();
        await command.run(
          argv.filter((_, i) => i !== route.index),
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
      logger.close();
      db.close();
      auxDb.close();
      if (memory) rmSync(dataDir, { recursive: true, force: true });
    },
  } as App;
  collections.app = app;
  settings.app = app;
  const logger = createLogger(app);
  app.logger = logger;
  registerSystemHooks(app);
  registerRealtimeHooks(app);
  registerCronJobs(app);
  registerAutoBackup(app);
  bindUIExtensions(app);

  for (const [name, run, help] of BUILTIN_COMMANDS)
    app.command(name, run, help);
  return app;
}
