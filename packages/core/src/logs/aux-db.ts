import { type Db, openDb } from "../db";

// PB migrations/1640988000_aux_init.go
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS _logs (
    id      TEXT PRIMARY KEY DEFAULT ('r'||lower(hex(randomblob(7)))) NOT NULL,
    level   INTEGER DEFAULT 0 NOT NULL,
    message TEXT DEFAULT "" NOT NULL,
    data    JSON DEFAULT "{}" NOT NULL,
    created TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%fZ')) NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_logs_level on _logs (level)",
  "CREATE INDEX IF NOT EXISTS idx_logs_message on _logs (message)",
  "CREATE INDEX IF NOT EXISTS idx_logs_created_hour on _logs (strftime('%Y-%m-%d %H:00:00', created))",
];

// bun:sqlite blocks the event loop while it waits for a lock, so a locked aux db fails a log batch fast
export const BUSY_TIMEOUT_MS = 100;

export function openAuxDb(path: string): Db {
  const db = openDb(path, BUSY_TIMEOUT_MS);
  db.tx(() => {
    for (const sql of SCHEMA) db.run(sql);
  });
  return db;
}
