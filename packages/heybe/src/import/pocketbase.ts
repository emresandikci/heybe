import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../app";
import type { SettingsData } from "../settings";
import { INSTALLER_EMAIL } from "../util";
import { decryptPbValue } from "./decrypt";

export interface ImportSummary {
  collections: number;
  records: number;
  files: number;
}

type Obj = Record<string, unknown>;

interface PbCollectionRow {
  id: string;
  system: number;
  type: string;
  name: string;
  fields: string;
  indexes: string;
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
  options: string;
  created: string;
  updated: string;
}

const quote = (name: string) => `\`${name.replaceAll("`", "``")}\``;

const tableInfo = (table: string) => `PRAGMA table_info(${quote(table)})`;

function toItem(row: PbCollectionRow): Obj {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    system: !!row.system,
    fields: JSON.parse(row.fields),
    indexes: JSON.parse(row.indexes),
    listRule: row.listRule,
    viewRule: row.viewRule,
    createRule: row.createRule,
    updateRule: row.updateRule,
    deleteRule: row.deleteRule,
    ...JSON.parse(row.options),
    created: row.created,
    updated: row.updated,
  };
}

function readSettings(
  pb: Database,
  encryptionKey?: string,
): Partial<SettingsData> | null {
  const row = pb
    .query<{ value: string | Uint8Array | null }, []>(
      "SELECT value FROM _params WHERE id = 'settings'",
    )
    .get();
  if (!row?.value) return null;
  const raw =
    typeof row.value === "string"
      ? row.value
      : new TextDecoder().decode(row.value);
  try {
    return JSON.parse(raw);
  } catch {}
  if (!encryptionKey)
    throw new Error(
      "the PocketBase settings are encrypted, pass --encryptionEnv with the name of the variable that holds the key",
    );
  try {
    return JSON.parse(decryptPbValue(raw, encryptionKey));
  } catch (e) {
    throw new Error(
      `failed to decrypt the PocketBase settings: ${(e as Error).message}`,
    );
  }
}

function assertFresh(app: App, storageDir: string): void {
  const notEmpty = new Error(
    `the Heybe data directory "${app.dataDir}" is not empty, import needs a fresh one`,
  );
  for (const c of app.collections.all()) {
    if (!c.system && c.id !== "_pb_users_auth_") throw notEmpty;
    if (c.type === "view") continue;
    const installer = c.name === "_superusers" ? " WHERE email != ?" : "";
    const { n } = app.db.get<{ n: number }>(
      `SELECT count(*) AS n FROM ${quote(c.name)}${installer}`,
      installer ? [INSTALLER_EMAIL] : [],
    )!;
    if (n > 0) throw notEmpty;
  }
  if (existsSync(storageDir) && readdirSync(storageDir).length > 0)
    throw notEmpty;
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("thumbs_"))
        count += countFiles(join(dir, entry.name));
    } else if (entry.isFile()) count++;
  }
  return count;
}

// PB must be stopped. data.db (and its -wal) is copied to a temp dir and the copy is read, so the
// PB dir is never touched: a WAL database cannot be opened read-only once PB removed its -shm.
export async function importPocketBase(
  app: App,
  pbDataDir: string,
  opts: { encryptionKey?: string } = {},
): Promise<ImportSummary> {
  const notPb = (reason: string) =>
    new Error(`"${pbDataDir}" is not a PocketBase data directory: ${reason}`);
  const dbPath = join(pbDataDir, "data.db");
  if (!existsSync(dbPath)) throw notPb("data.db is missing");
  const temp = mkdtempSync(join(tmpdir(), "heybe-import-"));
  let pb: Database | undefined;
  try {
    copyFileSync(dbPath, join(temp, "data.db"));
    if (existsSync(`${dbPath}-wal`))
      copyFileSync(`${dbPath}-wal`, join(temp, "data.db-wal"));
    pb = new Database(join(temp, "data.db"), { create: false });
    pb.run("BEGIN");
    const hasCollections = pb
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("_collections");
    if (!hasCollections) throw notPb("_collections is missing");
    const storageDir = join(app.dataDir, "storage");
    assertFresh(app, storageDir);
    const settings = readSettings(pb, opts.encryptionKey);
    const items = pb
      .query<PbCollectionRow, []>("SELECT * FROM _collections ORDER BY rowid")
      .all()
      .map(toItem);

    const pbStorage = join(pbDataDir, "storage");
    const copyFiles = !settings?.s3?.enabled && existsSync(pbStorage);
    const storageExisted = existsSync(storageDir);
    let records = 0;
    try {
      if (copyFiles)
        await cp(pbStorage, storageDir, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      await app.db.write(async () => {
        await app.collections.import(items, true);
        app.db.run(`DELETE FROM ${quote("_superusers")}`);
        for (const item of items) {
          if (item.type === "view") continue;
          const table = String(item.name);
          const target = new Set(
            app.db.query<{ name: string }>(tableInfo(table)).map((c) => c.name),
          );
          const shared = pb!
            .query<{ name: string }, []>(tableInfo(table))
            .all()
            .map((c) => c.name)
            .filter((c) => target.has(c));
          const insert = `INSERT INTO ${quote(table)} (${shared.map(quote).join(", ")}) VALUES (${shared.map(() => "?").join(", ")})`;
          for (const row of pb!
            .query<Obj, []>(
              `SELECT ${shared.map(quote).join(", ")} FROM ${quote(table)}`,
            )
            .iterate()) {
            app.db.run(
              insert,
              shared.map((c) => row[c] as string | number | null),
            );
            records++;
          }
        }
        if (settings) await app.settings.update(settings);
      });
    } catch (e) {
      rmSync(storageDir, { recursive: true, force: true });
      if (storageExisted) mkdirSync(storageDir);
      throw e;
    }
    await app.settings.reload();
    return {
      collections: items.length,
      records,
      files: copyFiles ? countFiles(pbStorage) : 0,
    };
  } finally {
    pb?.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
