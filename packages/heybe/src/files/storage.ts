import {
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

export interface StoredFile {
  blob: Blob;
  size: number;
  modified: Date;
}

export interface FileInfo {
  key: string;
  size: number;
  modified: Date;
}

export interface Filesystem {
  write(key: string, data: Blob | Uint8Array, type?: string): Promise<void>;
  file(key: string): Promise<StoredFile | null>;
  exists(key: string): Promise<boolean>;
  // every file under prefix, sorted by key
  list(prefix: string): Promise<FileInfo[]>;
  // rejects when the key does not exist
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>; // callers end prefix with "/" so local dirs and S3 key prefixes match the same files
}

export interface FileWatcher {
  // awaited before the delete runs
  deleting?(keyOrPrefix: string): Promise<void>;
  writing?(key: string): void;
}

export interface AppFilesystem extends Filesystem {
  watch(w: FileWatcher): () => void;
}

export function fileKey(
  collectionId: string,
  recordId: string,
  filename: string,
): string {
  return `${collectionId}/${recordId}/${filename}`;
}

const TEMP_FILE =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

const missing = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

// realpath of the deepest existing ancestor, joined with the parts that do not exist yet
async function realPathOf(path: string): Promise<string> {
  const rest: string[] = [];
  for (let p = path; ; p = dirname(p)) {
    try {
      return join(await realpath(p), ...rest);
    } catch (err) {
      if (!missing(err) || p === dirname(p)) throw err;
      rest.unshift(basename(p));
    }
  }
}

export function localFilesystem(root: string): Filesystem {
  const base = resolve(root);
  let realBase: Promise<string> | undefined;

  const pathOf = async (key: string): Promise<string> => {
    const trimmed = key.replace(/\/+$/, "");
    const segments = trimmed.split("/");
    if (
      trimmed === "" ||
      key.includes("\0") ||
      key.includes("\\") ||
      segments.includes("..") ||
      segments.includes(".")
    ) {
      throw new Error(`invalid file key ${JSON.stringify(key)}`);
    }
    const path = resolve(base, trimmed);
    if (
      !path.startsWith(base + sep) ||
      !(await realPathOf(path)).startsWith(
        (await (realBase ??= realPathOf(base))) + sep,
      )
    ) {
      throw new Error(`file key ${JSON.stringify(key)} escapes storage root`);
    }
    return path;
  };

  const statFile = (path: string) =>
    stat(path).then(
      (s) => (s.isFile() ? s : null),
      (err) => {
        if (missing(err)) return null;
        throw err;
      },
    );

  const walk = async (dir: string, out: FileInfo[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (missing(err)) return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else if (entry.isFile() && !TEMP_FILE.test(entry.name)) {
        const s = await statFile(path);
        if (!s) continue;
        const key = path
          .slice(base.length + 1)
          .split(sep)
          .join("/");
        out.push({ key, size: s.size, modified: s.mtime });
      }
    }
  };

  return {
    async write(key, data) {
      const path = await pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${crypto.randomUUID()}.tmp`;
      try {
        await Bun.write(temp, data);
        await rename(temp, path);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
    },
    async file(key) {
      const path = await pathOf(key);
      const s = await statFile(path);
      return s && { blob: Bun.file(path), size: s.size, modified: s.mtime };
    },
    async exists(key) {
      return (await statFile(await pathOf(key))) !== null;
    },
    async list(prefix) {
      if (prefix !== "") await pathOf(prefix);
      const dir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const out: FileInfo[] = [];
      await walk(dir === "" ? base : await pathOf(dir), out);
      return out
        .filter((f) => f.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    // empty parent dirs are removed too, so storage holds no leftovers of failed uploads
    async delete(key) {
      const path = await pathOf(key);
      try {
        await unlink(path);
      } catch (err) {
        if (missing(err))
          throw new Error(`blob (key ${JSON.stringify(key)}) (code=NotFound)`);
        throw err;
      }
      for (let dir = dirname(path); dir !== base; dir = dirname(dir)) {
        try {
          await rmdir(dir);
        } catch {
          break;
        }
      }
    },
    async deletePrefix(prefix) {
      await rm(await pathOf(prefix), { recursive: true, force: true });
    },
  };
}

export function appFilesystem(current: () => Filesystem): AppFilesystem {
  const watchers = new Set<FileWatcher>();
  const deleting = async (keyOrPrefix: string) => {
    for (const w of watchers) await w.deleting?.(keyOrPrefix);
  };
  return {
    write(key, data, type) {
      for (const w of watchers) w.writing?.(key);
      return current().write(key, data, type);
    },
    file: (key) => current().file(key),
    exists: (key) => current().exists(key),
    list: (prefix) => current().list(prefix),
    async delete(key) {
      await deleting(key);
      await current().delete(key);
    },
    async deletePrefix(prefix) {
      await deleting(prefix);
      await current().deletePrefix(prefix);
    },
    watch(w) {
      watchers.add(w);
      return () => {
        watchers.delete(w);
      };
    },
  };
}
