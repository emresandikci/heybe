import { Database } from "bun:sqlite";

declare var self: Worker;

let db: Database | null = null;

const closeDb = () => {
  try {
    db?.close();
  } catch {}
  db = null;
};

// Never creates the file. `close` comes before anything that needs the db files to itself.
self.onmessage = (
  e: MessageEvent<{
    id: number;
    path: string;
    close?: boolean;
    signal?: Int32Array;
  }>,
) => {
  const { id, path, close, signal } = e.data;
  if (close) {
    closeDb();
    if (signal) {
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
    }
    self.postMessage({ id });
    return;
  }
  try {
    db ??= new Database(path, { readwrite: true, create: false });
    const { busy, log, checkpointed } = db
      .query<{ busy: number; log: number; checkpointed: number }, []>(
        "PRAGMA wal_checkpoint(PASSIVE)",
      )
      .get()!;
    self.postMessage({ id, complete: busy === 0 && checkpointed >= log });
  } catch (err) {
    closeDb();
    self.postMessage({ id, error: (err as Error).message });
  }
};
