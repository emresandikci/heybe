import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface Filesystem {
  write(key: string, data: Blob | Uint8Array): Promise<void>;
  file(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export function fileKey(
  collectionId: string,
  recordId: string,
  filename: string,
): string {
  return `${collectionId}/${recordId}/${filename}`;
}

export function localFilesystem(root: string): Filesystem {
  const base = resolve(root);

  const pathOf = (key: string): string => {
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
    if (!path.startsWith(base + sep)) {
      throw new Error(`file key ${JSON.stringify(key)} escapes storage root`);
    }
    return path;
  };

  return {
    async write(key, data) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, data);
    },
    async file(key) {
      const blob = Bun.file(pathOf(key));
      return (await blob.exists()) ? blob : null;
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
    async deletePrefix(prefix) {
      await rm(pathOf(prefix), { recursive: true, force: true });
    },
  };
}
