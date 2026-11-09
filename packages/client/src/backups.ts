import type { HeybeClient } from "./client.js";
import type { RequestOptions } from "./send.js";

export interface BackupInfo {
  key: string;
  size: number;
  modified: string;
}

export interface BackupsService {
  list(opts?: RequestOptions): Promise<BackupInfo[]>;
  create(name?: string, opts?: RequestOptions): Promise<void>;
  upload(file: Blob, opts?: RequestOptions): Promise<void>;
  delete(key: string, opts?: RequestOptions): Promise<void>;
  restore(key: string, opts?: RequestOptions): Promise<void>;
  downloadURL(token: string, key: string): string;
}

const enc = encodeURIComponent;

export function createBackups(
  client: Pick<HeybeClient, "send" | "buildURL">,
): BackupsService {
  return {
    list: (opts) => client.send("/api/backups", opts),
    create: (name, opts) =>
      client.send("/api/backups", {
        ...opts,
        method: "POST",
        body: { name },
      }),
    upload(file, opts) {
      const body = new FormData();
      body.append("file", file);
      return client.send("/api/backups/upload", {
        ...opts,
        method: "POST",
        body,
      });
    },
    delete: (key, opts) =>
      client.send(`/api/backups/${enc(key)}`, { ...opts, method: "DELETE" }),
    restore: (key, opts) =>
      client.send(`/api/backups/${enc(key)}/restore`, {
        ...opts,
        method: "POST",
      }),
    downloadURL: (token, key) =>
      `${client.buildURL(`/api/backups/${enc(key)}`)}?token=${enc(token)}`,
  };
}
