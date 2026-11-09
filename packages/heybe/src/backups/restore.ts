import { Database } from "bun:sqlite";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { App } from "../app";
import { exclusive, reopen } from "../db";
import { BackupEvent } from "../hooks/events";
import { errorMessage, randomSecret } from "../util";
import { BACKUP_EXCLUDE, LOCAL_BACKUPS_DIR, LOCAL_TEMP_DIR } from "./create";
import { extractZip } from "./zip";

// Port of PB core/backup_restore.go.

// PB osutils.MoveDirContent: on a failed rename the entries moved so far go back
function moveDirContent(src: string, dest: string, exclude: string[]) {
  const entries = readdirSync(src);
  let created = false;
  try {
    statSync(dest);
  } catch {
    mkdirSync(dest);
    created = true;
  }
  const moved: string[] = [];
  for (const name of entries) {
    if (exclude.includes(name)) continue;
    try {
      renameSync(join(src, name), join(dest, name));
    } catch (err) {
      for (const m of moved) renameSync(join(dest, m), join(src, m));
      if (created) rmdirSync(dest);
      throw err;
    }
    moved.push(name);
  }
}

// a Heybe data.db has _collections with a data column (a PocketBase one has fields instead)
function checkDataDb(path: string) {
  try {
    statSync(path);
  } catch (err) {
    throw new Error(`data.db file is missing or invalid: ${errorMessage(err)}`);
  }
  let heybe = false;
  try {
    const db = new Database(path, { readwrite: true, create: false });
    try {
      heybe = db
        .query<{ name: string }, []>("PRAGMA table_info(_collections)")
        .all()
        .some((c) => c.name === "data");
    } finally {
      db.close();
    }
  } catch {}
  if (!heybe)
    throw new Error("data.db file is missing or invalid: not a Heybe backup");
}

// the db files were renamed and moved back, which breaks the open connections on macOS
const reopenDbs = (app: App) => {
  reopen(app.db);
  reopen(app.auxDb);
};

// both write mutexes are held while the data dir content is swapped
const swap = (app: App, fn: () => void) =>
  exclusive(app.db, () => exclusive(app.auxDb, fn));

export async function restoreBackup(
  app: App,
  name: string,
  restart: (revert: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const event = BackupEvent.of({ app, name, exclude: [...BACKUP_EXCLUDE] });
  await app.hooks.onBackupRestore.trigger(event, async (e) => {
    if (process.platform === "win32")
      throw new Error("restore is not supported on Windows");
    const dataDir = e.app.dataDir;
    const tempDir = join(dataDir, LOCAL_TEMP_DIR);
    await mkdir(tempDir, { recursive: true });
    const fsys = e.app.newBackupsFilesystem();
    if (!(await fsys.exists(name).catch(() => false)))
      throw new Error(
        `missing or invalid backup file ${JSON.stringify(name)} to restore`,
      );

    const extracted = join(tempDir, `pb_restore_${randomSecret(8)}`);
    try {
      if (e.app.settings.current().backups.s3.enabled) {
        const tempZip = join(tempDir, `pb_restore_zip${randomSecret(10)}`);
        try {
          const file = await fsys.file(name);
          if (!file)
            throw new Error(
              `missing or invalid backup file ${JSON.stringify(name)} to restore`,
            );
          await Bun.write(tempZip, file.blob);
          await extractZip(tempZip, extracted);
        } finally {
          await rm(tempZip, { force: true });
        }
      } else {
        await extractZip(
          join(dataDir, LOCAL_BACKUPS_DIR, basename(name)),
          extracted,
        );
      }
      checkDataDb(join(extracted, "data.db"));

      const old = join(tempDir, `old_pb_data_${randomSecret(8)}`);
      // queued entries would otherwise hit the moved auxiliary.db on the restart flush
      await e.app.logger.flush();
      await swap(e.app, () => {
        try {
          moveDirContent(dataDir, old, e.exclude);
        } catch (err) {
          reopenDbs(e.app);
          throw new Error(
            `failed to move the current pb_data content to a temp location: ${errorMessage(err)}`,
          );
        }
        try {
          moveDirContent(extracted, dataDir, e.exclude);
        } catch (err) {
          moveDirContent(old, dataDir, e.exclude);
          reopenDbs(e.app);
          throw new Error(
            `failed to move the extracted archive content to pb_data: ${errorMessage(err)}`,
          );
        }
      });

      // the connections reopen on the old files, which a rename broke on macOS
      let reverted = false;
      const revert = async () => {
        if (reverted) return;
        reverted = true;
        await swap(e.app, () => {
          moveDirContent(dataDir, extracted, e.exclude);
          moveDirContent(old, dataDir, e.exclude);
          reopenDbs(e.app);
        });
      };
      try {
        await restart(revert);
      } catch (err) {
        await revert();
        throw new Error(
          `failed to restart the app process: ${errorMessage(err)}`,
        );
      }
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  });
}
