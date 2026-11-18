import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "./db";

export function tempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "heybe-db-"));
  const db = openDb(join(dir, "data.db"));
  const close = db.close;
  db.close = () => {
    close();
    rmSync(dir, { recursive: true, force: true });
  };
  return db;
}
