import type { S3Config } from "../settings";
import { type Timers, realTimers } from "../timers";
import { sniffMime } from "./mime";
import type { FileInfo, Filesystem, RemoteFile } from "./storage";

export const S3_TIMEOUT_MS = 60_000;

const notFound = (err: unknown) =>
  (err as { code?: string }).code === "NoSuchKey" ||
  (err as { code?: string }).code === "NotFound";

export function s3Filesystem(
  config: S3Config,
  timers: Timers = realTimers,
): Filesystem {
  const client = new Bun.S3Client({
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
    accessKeyId: config.accessKey,
    secretAccessKey: config.secret,
    virtualHostedStyle: !config.forcePathStyle,
  });

  // Bun's S3Client calls take no AbortSignal: on timeout they are only abandoned, fetch GETs are aborted
  const timed = <T>(
    run: (signal: AbortSignal) => Promise<T>,
    abort = new AbortController(),
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        abort.abort();
        reject(new Error("S3 request timed out"));
      }, S3_TIMEOUT_MS);
      Promise.resolve()
        .then(() => run(abort.signal))
        .then(resolve, reject)
        .finally(() => timers.clearTimeout(timer));
    });

  // a GET body whose every read is under the timeout
  const get = async (key: string, range?: string) => {
    const abort = new AbortController();
    const res = await timed(
      (signal) =>
        fetch(client.file(key).presign({ method: "GET" }), {
          signal,
          headers: range ? { range } : {},
          decompress: false,
        }),
      abort,
    );
    if (!res.ok) {
      await res.body?.cancel();
      throw Object.assign(
        new Error(`S3 GET ${key} failed with status ${res.status}`),
        { status: res.status },
      );
    }
    const reader = (res.body ?? new Blob().stream()).getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { done, value } = await timed(() => reader.read(), abort);
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel(reason) {
        abort.abort();
        void reader.cancel(reason).catch(() => {});
      },
    });
    return { headers: res.headers, body };
  };

  const lazy = (open: () => Promise<ReadableStream<Uint8Array>>) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        reader ??= (await open()).getReader();
        const { done, value } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel: (reason) => reader?.cancel(reason),
    });
  };

  // like PB's S3 ReadSeeker: the GET that opened the file serves it whole, any other read is its own ranged GET
  const remote = (
    key: string,
    stat: { size: number; modified: Date; type: string },
    opened: ReadableStream<Uint8Array> | null,
  ): RemoteFile => {
    let first = opened;
    const close = () => {
      void first?.cancel().catch(() => {});
      first = null;
    };
    return {
      ...stat,
      read(start, length) {
        const whole = start === 0 && length === stat.size;
        if (whole && first) {
          const body = first;
          first = null;
          return body;
        }
        close();
        const range = whole
          ? undefined
          : `bytes=${start}-${start + length - 1}`;
        return lazy(async () => (await get(key, range)).body);
      },
      close,
    };
  };

  const stat = async (key: string) => {
    try {
      return await timed(() => client.file(key).stat());
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  };

  const list = async (prefix: string): Promise<FileInfo[]> => {
    const out: FileInfo[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await timed(() =>
        client.list({ prefix, continuationToken }),
      );
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
      const t = type ?? (await sniffMime(data));
      await timed(() => client.write(key, data, { type: t }));
    },
    async file(key) {
      const s = await stat(key);
      return (
        s && {
          blob: client.file(key),
          size: s.size,
          modified: s.lastModified,
          type: s.type,
        }
      );
    },
    async open(key, statOnly) {
      if (!statOnly) {
        let opened;
        try {
          opened = await get(key);
        } catch (err) {
          if ((err as { status?: number }).status === 404) return null;
          throw err;
        }
        const length = opened.headers.get("content-length");
        if (length !== null)
          return remote(
            key,
            {
              size: Number(length),
              modified: new Date(opened.headers.get("last-modified") ?? 0),
              type:
                opened.headers.get("content-type") ??
                "application/octet-stream",
            },
            opened.body,
          );
        await opened.body.cancel();
      }
      const s = await stat(key);
      return (
        s &&
        remote(
          key,
          { size: s.size, modified: s.lastModified, type: s.type },
          null,
        )
      );
    },
    exists: (key) => timed(() => client.exists(key)),
    list,
    async delete(key) {
      await timed(() => client.delete(key));
    },
    // like PB DeletePrefix: every key is tried, the first failure is thrown at the end
    async deletePrefix(prefix) {
      const failed: unknown[] = [];
      for (const f of await list(prefix))
        await timed(() => client.delete(f.key)).catch((err) =>
          failed.push(err),
        );
      if (failed.length > 0) throw failed[0];
    },
  };
}
