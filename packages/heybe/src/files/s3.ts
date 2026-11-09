import type { S3Config } from "../settings";
import { sniffMime } from "./mime";
import type { FileInfo, Filesystem } from "./storage";

const notFound = (err: unknown) =>
  (err as { code?: string }).code === "NoSuchKey" ||
  (err as { code?: string }).code === "NotFound";

export function s3Filesystem(config: S3Config): Filesystem {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.accessKey,
    secretAccessKey: config.secret,
    virtualHostedStyle: !config.forcePathStyle,
  });

  const list = async (prefix: string): Promise<FileInfo[]> => {
    const out: FileInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await client.list({ prefix, continuationToken });
      for (const o of page.contents ?? [])
        out.push({
          key: o.key,
          size: o.size ?? 0,
          modified: new Date(o.lastModified ?? 0),
        });
      continuationToken = page.isTruncated
        ? page.nextContinuationToken
        : undefined;
    } while (continuationToken);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };

  return {
    async write(key, data, type) {
      await client.write(key, data, { type: type ?? (await sniffMime(data)) });
    },
    async file(key) {
      const blob = client.file(key);
      try {
        const s = await blob.stat();
        return { blob, size: s.size, modified: s.lastModified };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    exists: (key) => client.exists(key),
    list,
    async delete(key) {
      await client.delete(key);
    },
    // like PB DeletePrefix: every key is tried, the first failure is thrown at the end
    async deletePrefix(prefix) {
      const failed: unknown[] = [];
      for (const f of await list(prefix))
        await client.delete(f.key).catch((err) => failed.push(err));
      if (failed.length > 0) throw failed[0];
    },
  };
}
