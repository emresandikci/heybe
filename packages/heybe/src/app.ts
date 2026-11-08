import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { CollectionStore } from "./collections/store";
import { type Db, openDb } from "./db";
import { type Filesystem, localFilesystem } from "./files/storage";
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

export interface App extends HookBinders {
  db: Db;
  hooks: Hooks;
  collections: CollectionStore;
  settings: Settings;
  files: Filesystem;
  mailer: Mailer;
  now: () => Date;
  records<N extends CollectionName>(name: N): RecordService<Collections[N]>;
  records(name: string): RecordService<Record<string, unknown>>;
  close(): void;
}

export function createApp(opts: { dir: string; now?: () => Date }): App {
  const memory = opts.dir === "" || opts.dir === ":memory:";
  if (!memory) mkdirSync(opts.dir, { recursive: true });
  const storageRoot = memory
    ? mkdtempSync(join(tmpdir(), "heybe-storage-"))
    : join(opts.dir, "storage");
  const db = openDb(join(memory ? storageRoot : opts.dir, "data.db"));
  const now = opts.now ?? (() => new Date());
  const files = localFilesystem(storageRoot);
  const collections = new CollectionStore(db, now, files);
  const settings = new Settings(db);
  const hooks = createHooks();

  const app = {
    ...hookBinders(hooks),
    db,
    hooks,
    collections,
    settings,
    files,
    mailer: { send: (msg) => mailerFromSettings(settings.get()).send(msg) },
    now,
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
    close: () => {
      db.close();
      if (memory) rmSync(storageRoot, { recursive: true, force: true });
    },
  } as App;
  return app;
}
