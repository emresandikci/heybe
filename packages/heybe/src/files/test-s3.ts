export interface FakeObject {
  body: Uint8Array<ArrayBuffer>;
  type: string;
  modified: Date;
}

export interface FakeS3 {
  endpoint: string;
  objects(bucket: string): Map<string, FakeObject>;
  requests: { method: string; path: string }[];
  // the next request answers an S3 XML error
  failNext(status: number, code: string): void;
  stop(): Promise<void>;
}

const xmlEscape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

const s3Error = (method: string, status: number, code: string) =>
  method === "HEAD"
    ? new Response(null, { status })
    : xml(
        `<Error><Code>${code}</Code><Message>${code} error</Message></Error>`,
        status,
      );

const etag = (body: Uint8Array) =>
  `"${new Bun.CryptoHasher("md5").update(body).digest("hex")}"`;

function range(header: string | null, size: number): [number, number] | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") return [Math.max(0, size - Number(m[2])), size - 1];
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return [Number(m[1]), end];
}

export async function startFakeS3(
  opts: { now?: () => Date } = {},
): Promise<FakeS3> {
  const now = opts.now ?? (() => new Date());
  const buckets = new Map<string, Map<string, FakeObject>>();
  const uploads = new Map<
    string,
    { key: string; type: string; parts: Map<number, Uint8Array<ArrayBuffer>> }
  >();
  const requests: FakeS3["requests"] = [];
  let failure: { status: number; code: string } | null = null;
  let uploadSeq = 0;

  const objects = (bucket: string) => {
    let b = buckets.get(bucket);
    if (!b) buckets.set(bucket, (b = new Map()));
    return b;
  };

  const list = (bucket: string, q: URLSearchParams) => {
    const prefix = q.get("prefix") ?? "";
    const max = Number(q.get("max-keys") ?? 1000);
    const after = q.get("continuation-token") ?? "";
    const keys = [...objects(bucket).keys()]
      .filter((k) => k.startsWith(prefix) && k > after)
      .sort();
    const page = keys.slice(0, max);
    const truncated = keys.length > page.length;
    const contents = page
      .map((k) => {
        const o = objects(bucket).get(k)!;
        return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.modified.toISOString()}</LastModified><ETag>${xmlEscape(etag(o.body))}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
      })
      .join("");
    return xml(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${xmlEscape(page.at(-1)!)}</NextContinuationToken>` : ""}</ListBucketResult>`,
    );
  };

  const get = (req: Request, o: FakeObject) => {
    const headers = {
      "content-type": o.type,
      "last-modified": o.modified.toUTCString(),
      etag: etag(o.body),
      "accept-ranges": "bytes",
    };
    const r = range(req.headers.get("range"), o.body.length);
    if (!r) return new Response(o.body, { headers });
    return new Response(o.body.slice(r[0], r[1] + 1), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${r[0]}-${r[1]}/${o.body.length}`,
      },
    });
  };

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const q = url.searchParams;
    const slash = url.pathname.indexOf("/", 1);
    const bucket = decodeURIComponent(
      url.pathname.slice(1, slash < 0 ? undefined : slash),
    );
    const key =
      slash < 0 ? "" : decodeURIComponent(url.pathname.slice(slash + 1));
    const store = objects(bucket);

    if (key === "") {
      if (req.method === "GET") return list(bucket, q);
      return s3Error(req.method, 405, "MethodNotAllowed");
    }

    const uploadId = q.get("uploadId");
    if (req.method === "POST" && q.has("uploads")) {
      const id = String(++uploadSeq);
      uploads.set(id, {
        key,
        type: req.headers.get("content-type") ?? "application/octet-stream",
        parts: new Map(),
      });
      return xml(
        `<InitiateMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (uploadId !== null) {
      const upload = uploads.get(uploadId);
      if (!upload) return s3Error(req.method, 404, "NoSuchUpload");
      if (req.method === "PUT") {
        const body = await req.bytes();
        upload.parts.set(Number(q.get("partNumber")), body);
        return new Response(null, { headers: { etag: etag(body) } });
      }
      uploads.delete(uploadId);
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const parts = [...upload.parts].sort(([a], [b]) => a - b);
      const body = new Uint8Array(
        await new Blob(parts.map(([, p]) => p)).arrayBuffer(),
      );
      store.set(key, { body, type: upload.type, modified: now() });
      return xml(
        `<CompleteMultipartUploadResult><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag(body))}</ETag></CompleteMultipartUploadResult>`,
      );
    }

    const o = store.get(key);
    switch (req.method) {
      case "PUT": {
        const body = await req.bytes();
        store.set(key, {
          body,
          type: req.headers.get("content-type") ?? "application/octet-stream",
          modified: now(),
        });
        return new Response(null, { headers: { etag: etag(body) } });
      }
      case "GET":
      case "HEAD":
        if (!o) return s3Error(req.method, 404, "NoSuchKey");
        return get(req, o);
      case "DELETE":
        store.delete(key);
        return new Response(null, { status: 204 });
    }
    return s3Error(req.method, 405, "MethodNotAllowed");
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname + url.search });
      if (failure) {
        const { status, code } = failure;
        failure = null;
        return s3Error(req.method, status, code);
      }
      return handle(req);
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    objects,
    requests,
    failNext(status, code) {
      failure = { status, code };
    },
    stop: () => server.stop(true),
  };
}
