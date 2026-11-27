import { mkdir, readdir, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { App } from "../app";
import { type Db, exclusive } from "../db";
import { BackupEvent } from "../hooks/events";
import { randomSecret } from "../util";
import { type ZipWriter, createZipWriter } from "./zip";

// Port of PB core/backup.go and core/backup_create.go.

export const LOCAL_BACKUPS_DIR = "backups";
export const LOCAL_TEMP_DIR = ".hb_temp_to_delete";
export const BACKUP_EXCLUDE = [LOCAL_BACKUPS_DIR, LOCAL_TEMP_DIR, "lost+found"];

// PB inflector.Snakecase
export function snakecase(s: string): string {
  return s
    .split(/[\W_]+/)
    .filter((w) => w !== "")
    .map((w) => w.replace(/(?<=[^A-Z])[A-Z]/g, (c) => `_${c}`))
    .join("_")
    .toLowerCase();
}

export function generateBackupName(app: App, prefix: string): string {
  const appName = snakecase(app.settings.current().meta.appName).slice(0, 50);
  const date = app.now().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${prefix}${appName}_${date}.zip`;
}

// PB normalizePathExclude
const normalizeExclude = (path: string) =>
  `${posix.normalize(path).replace(/\/+$/, "")}/`;

const missing = (err: unknown) =>
  (err as NodeJS.ErrnoException).code === "ENOENT";

export async function createBackup(app: App, name: string): Promise<void> {
  const event = BackupEvent.of({ app, name, exclude: [...BACKUP_EXCLUDE] });
  await app.hooks.onBackupCreate.trigger(event, async (e) => {
    if (e.name === "") e.name = generateBackupName(e.app, "hb_backup_");
    const tempDir = join(app.dataDir, LOCAL_TEMP_DIR);
    await mkdir(tempDir, { recursive: true });
    const tempZip = join(tempDir, `hb_backup_${randomSecret(6)}`);
    try {
      await createZip(e, tempDir, tempZip);
      await e.app
        .newBackupsFilesystem()
        .write(e.name, Bun.file(tempZip), "application/zip");
    } finally {
      await rm(tempZip, { force: true });
    }
  });
}

async function createZip(e: BackupEvent, tempDir: string, zipPath: string) {
  const { app } = e;
  const zip = await createZipWriter(zipPath);
  const excluded = new Set(e.exclude.map(normalizeExclude));
  const s3 = () => app.settings.current().s3.enabled;

  // each name is zipped once, by the storage walk or by the deleting watcher
  const zipped = new Map<string, Promise<void>>();
  const add = (path: string, name: string) => {
    let added = zipped.get(name);
    if (!added) {
      added = zip.addFile(path, name);
      zipped.set(name, added);
    }
    return added;
  };

  // a stored file deleted while the backup runs still belongs to the data.db snapshot
  const unwatchDeleting = app.files.watch({
    async deleting(keyOrPrefix) {
      if (s3()) return;
      // a failure here never blocks the delete
      const files = await app.files.list(keyOrPrefix).catch(() => []);
      for (const f of files) {
        if (!keyOrPrefix.endsWith("/") && f.key !== keyOrPrefix) continue;
        const zipName = `storage/${f.key}`;
        if (excluded.has(normalizeExclude(zipName))) continue;
        try {
          await add(join(app.dataDir, "storage", f.key), zipName);
        } catch (error) {
          zipped.delete(zipName);
          app.logger.warn(
            `[${e.name}] failed to copy file in backup zip before delete`,
            { error, file: f.key },
          );
        }
      }
    },
  });
  let unwatchWriting = () => {};
  try {
    // files written after the data.db snapshot are not part of it
    await copyDb(app.db, "data.db", tempDir, zip, () => {
      unwatchWriting = app.files.watch({
        writing(key) {
          if (!s3()) excluded.add(normalizeExclude(`storage/${key}`));
        },
      });
    });
    excludeDb(excluded, "data.db");
    await copyDb(app.auxDb, "auxiliary.db", tempDir, zip);
    excludeDb(excluded, "auxiliary.db");
    await copyDir(add, app.dataDir, "", excluded);
  } finally {
    unwatchDeleting();
    unwatchWriting();
    await zip.close();
  }
}

// VACUUM INTO in a worker: the caller holds `exclusive` so writes wait, while reads and requests keep running
export function vacuumInto(
  path: string,
  dest: string,
  busyTimeoutMs: number,
): Promise<void> {
  const worker = new Worker(new URL("./vacuum-worker.ts", import.meta.url));
  return new Promise<void>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<{ error?: string }>) =>
      e.data.error === undefined ? resolve() : reject(new Error(e.data.error));
    worker.onerror = (e) => reject(e.error ?? new Error(e.message));
    worker.postMessage({ path, dest, busyTimeoutMs });
  }).finally(() => worker.terminate());
}

async function copyDb(
  db: Db,
  file: string,
  tempDir: string,
  zip: ZipWriter,
  copied?: () => void,
) {
  const temp = join(tempDir, file);
  try {
    await exclusive(db, async (s) => {
      const { timeout } = s
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()!;
      await vacuumInto(s.filename, temp, timeout);
      copied?.();
    });
    await zip.addFile(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function excludeDb(excluded: Set<string>, file: string) {
  for (const suffix of ["", "-wal", "-shm"])
    excluded.add(normalizeExclude(file + suffix));
}

// regular files only; the excluded set is re-read on each entry since watchers keep adding to it
async function copyDir(
  add: (path: string, name: string) => Promise<void>,
  dir: string,
  prefix: string,
  excluded: Set<string>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = prefix + entry.name;
    const check = normalizeExclude(name);
    if ([...excluded].some((p) => check.startsWith(p))) continue;
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) await copyDir(add, path, `${name}/`, excluded);
      else if (entry.isFile()) await add(path, name);
    } catch (err) {
      // removed while the backup runs
      if (!missing(err)) throw err;
    }
  }
}
