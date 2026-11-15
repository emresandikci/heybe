import { Database, type SQLQueryBindings } from "bun:sqlite";

declare var self: Worker;

const INSERT =
  "INSERT INTO _logs (id, level, message, data, created) VALUES (?, ?, ?, ?, ?)";

let db: Database | null = null;
let insert: ReturnType<Database["prepare"]>;

const closeDb = () => {
  try {
    db?.close();
  } catch {}
  db = null;
};

// Never creates the file. `close` comes before a restore swaps auxiliary.db, and a failed
// batch closes too, in case the file under the connection was replaced.
self.onmessage = (
  e: MessageEvent<{
    id: number;
    path: string;
    busyTimeoutMs: number;
    close?: boolean;
    rows: unknown[][];
  }>,
) => {
  const { id, path, busyTimeoutMs, close, rows } = e.data;
  try {
    if (close) {
      closeDb();
      self.postMessage({ id });
      return;
    }
    if (!db) {
      db = new Database(path, { readwrite: true, create: false });
      db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.run("PRAGMA synchronous = NORMAL");
      insert = db.prepare(INSERT);
    }
    db.transaction(() => {
      for (const row of rows) insert.run(...(row as SQLQueryBindings[]));
    }).immediate();
    self.postMessage({ id });
  } catch (err) {
    closeDb();
    self.postMessage({ id, error: (err as Error).message });
  }
};
