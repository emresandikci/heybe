import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { CollectionStore } from "./collections/store";
import { type Db, openDb } from "./db";
import { type Filesystem, localFilesystem } from "./files/storage";
import { type RecordService, RecordServiceImpl } from "./records/service";
import { Settings } from "./settings";

export interface App {
  db: Db;
  collections: CollectionStore;
  settings: Settings;
  files: Filesystem;
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
  const collections = new CollectionStore(db, now);
  const settings = new Settings(db);

  return {
    db,
    collections,
    settings,
    files: localFilesystem(storageRoot),
    now,
    records: (name: string) =>
      new RecordServiceImpl({ db, store: collections, now }, name),
    close: () => {
      db.close();
      if (memory) rmSync(storageRoot, { recursive: true, force: true });
    },
  } as App;
}
