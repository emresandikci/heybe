import type { HeybeClient } from "./client.js";
import { serializeQuery, type RequestOptions } from "./send.js";

export interface Files {
  url(
    record: { id?: string; collectionId?: string; collectionName?: string },
    filename: string,
    opts?: { thumb?: string; download?: boolean; token?: string },
  ): string;
  token(opts?: RequestOptions): Promise<string>;
}

export function createFiles(
  client: Pick<HeybeClient, "send" | "buildURL">,
): Files {
  return {
    url(record, filename, opts = {}) {
      const collection = record.collectionId || record.collectionName;
      if (!filename || !record.id || !collection) return "";
      const enc = encodeURIComponent;
      const url = client.buildURL(
        `api/files/${enc(collection)}/${enc(record.id)}/${enc(filename)}`,
      );
      const query = serializeQuery({
        ...opts,
        download: opts.download || undefined,
      });
      return query ? `${url}?${query}` : url;
    },
    async token(opts) {
      const res = await client.send<{ token?: string }>("/api/files/token", {
        ...opts,
        method: "POST",
      });
      return res?.token || "";
    },
  };
}
