import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CollectionName, Collections } from "@heybe/query";
import { CollectionStore } from "./collections/store";
import { type Db, openDb } from "./db";
import { type RecordService, RecordServiceImpl } from "./records/service";

export interface App {
  db: Db;
  collections: CollectionStore;
  now: () => Date;
  records<N extends CollectionName>(name: N): RecordService<Collections[N]>;
  records(name: string): RecordService<Record<string, unknown>>;
  close(): void;
}

export function createApp(opts: { dir: string; now?: () => Date }): App {
  const memory = opts.dir === "" || opts.dir === ":memory:";
  if (!memory) mkdirSync(opts.dir, { recursive: true });
  const db = openDb(memory ? ":memory:" : join(opts.dir, "data.db"));
  const now = opts.now ?? (() => new Date());
  const collections = new CollectionStore(db, now);

  return {
    db,
    collections,
    now,
    records: (name: string) =>
      new RecordServiceImpl({ db, store: collections, now }, name),
    close: () => db.close(),
  } as App;
}
