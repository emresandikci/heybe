import { Database, type SQLQueryBindings } from "bun:sqlite";

declare var self: Worker;

const INSERT =
  "INSERT INTO _logs (id, level, message, data, created) VALUES (?, ?, ?, ?, ?)";

// A connection per batch, never creating the file: a restore that swapped auxiliary.db
// between batches cannot leave the worker on the replaced file.
self.onmessage = (
  e: MessageEvent<{
    id: number;
    path: string;
    busyTimeoutMs: number;
    rows: unknown[][];
  }>,
) => {
  const { id, path, busyTimeoutMs, rows } = e.data;
  try {
    const db = new Database(path, { readwrite: true, create: false });
    try {
      db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.run("PRAGMA synchronous = NORMAL");
      const insert = db.prepare(INSERT);
      db.transaction(() => {
        for (const row of rows) insert.run(...(row as SQLQueryBindings[]));
      }).immediate();
    } finally {
      db.close();
    }
    self.postMessage({ id });
  } catch (err) {
    self.postMessage({ id, error: (err as Error).message });
  }
};
