import { Database } from "bun:sqlite";

declare var self: Worker;

self.onmessage = (
  e: MessageEvent<{ path: string; dest: string; busyTimeoutMs: number }>,
) => {
  const { path, dest, busyTimeoutMs } = e.data;
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.run("VACUUM INTO ?", [dest]);
    } finally {
      db.close();
    }
    self.postMessage({});
  } catch (err) {
    self.postMessage({ error: (err as Error).message });
  }
};
