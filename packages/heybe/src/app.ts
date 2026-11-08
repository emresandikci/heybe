import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { CollectionStore } from "./collections/store";
import { type Db, openDb } from "./db";
import { type Filesystem, localFilesystem } from "./files/storage";
import { type Mailer, mailerFromSettings } from "./mail/mailer";
import { type RecordService, RecordServiceImpl } from "./records/service";
import { Settings } from "./settings";

export interface App {
  db: Db;
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
  const db = openDb(memory ? ":memory:" : join(opts.dir, "data.db"));
  const now = opts.now ?? (() => new Date());
  const files = localFilesystem(storageRoot);
  const collections = new CollectionStore(db, now, files);
  const settings = new Settings(db);

  return {
    db,
    collections,
    settings,
    files,
    mailer: { send: (msg) => mailerFromSettings(settings.get()).send(msg) },
    now,
    records: (name: string) =>
      new RecordServiceImpl({ db, store: collections, files, now }, name),
    close: () => {
      db.close();
      if (memory) rmSync(storageRoot, { recursive: true, force: true });
    },
  } as App;
}
