import { newFileToken, authFromToken } from "../../auth/tokens";
import type { Collection } from "../../collections/model";
import { findRecordByViewFile } from "../../collections/view";
import { uniqueStrings } from "../../fields/shared";
import { sniffMime } from "../../files/mime";
import {
  type Filesystem,
  type StoredFile,
  type RemoteFile,
  fileKey,
} from "../../files/storage";
import { createThumb, thumbGenerator } from "../../files/thumbs";
import { buildRequestInfo, ruleFilter } from "../../records/rules";
import { ApiError } from "../errors";
import { checkSuperuserIp } from "../middlewares";
import { collectionPathRateLimit } from "../rate-limit";
import type { RequestEvent, Router } from "../router";
import {
  FileDownloadRequestEvent,
  FileTokenRequestEvent,
} from "../../hooks/events";
import { RecordModel } from "../../records/model";
import { NotFoundError } from "../../util";
import { internalRecords } from "../../records/internal";

const INLINE_TYPES = new Set([
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/bmp",
  "video/webm",
  "video/mp4",
  "video/3gpp",
  "video/quicktime",
  "video/x-ms-wmv",
  "audio/basic",
  "audio/aiff",
  "audio/mpeg",
  "audio/midi",
  "audio/mp3",
  "audio/wave",
  "audio/wav",
  "audio/x-wav",
  "audio/x-mpeg",
  "audio/x-m4a",
  "audio/aac",
  "application/pdf",
  "application/x-pdf",
]);

const EXTENSION_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const THUMB_TYPES = new Set([
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const DEFAULT_THUMB_SIZES = ["100x100"];

const generateThumb = thumbGenerator(createThumb);

const TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
};

function canView(
  e: RequestEvent,
  c: Collection,
  recordId: string,
  token: string,
): boolean {
  let auth = authFromToken(e.app, token, "file");
  if (auth?.isSuperuser) {
    try {
      checkSuperuserIp(e.app, e.req, e.remoteIp);
    } catch {
      auth = null;
    }
  }
  const info = {
    ...buildRequestInfo(e, {}, "protectedFile"),
    auth: auth?.record ?? null,
    authCollection: auth?.collection.name ?? null,
  };
  try {
    ruleFilter(e.app, c, c.viewRule, "view", info, recordId);
    return true;
  } catch {
    return false;
  }
}

const readFile = (e: RequestEvent, key: string) =>
  e.app.files.file(key).catch(() => null);

async function download(e: RequestEvent): Promise<void> {
  const c = e.app.collections.findCached(e.params.collection!);
  if (!c) throw new ApiError(404, "Missing or invalid collection context.");

  let record: Record<string, unknown>;
  try {
    record = internalRecords(e.app, c.name).findRaw(e.params.recordId!);
  } catch {
    throw new ApiError(404, "");
  }

  const filename = e.params.filename!;
  const field = c.fields.find(
    (f) =>
      f.type === "file" && uniqueStrings(record[f.name]).includes(filename),
  );
  if (!field) throw new ApiError(404, "");

  if (
    field.protected === true &&
    !canView(e, c, record.id as string, e.query.get("token") ?? "")
  )
    throw new ApiError(404, "");

  let base = { collectionId: c.id, recordId: record.id as string };
  if (c.type === "view") {
    let source: ReturnType<typeof findRecordByViewFile>;
    try {
      source = findRecordByViewFile(
        e.app.db,
        e.app.collections,
        c,
        field.name,
        filename,
      );
    } catch {
      source = null;
    }
    if (!source) throw new ApiError(404, "");
    base = { collectionId: source.collection.id, recordId: source.id };
  }

  const originalKey = fileKey(base.collectionId, base.recordId, filename);
  const served = {
    servedPath: originalKey,
    servedName: filename,
    thumbError: null as Error | null,
  };

  let originalType: string | undefined;
  const thumb = e.query.get("thumb") ?? "";
  const thumbsOf = Array.isArray(field.thumbs) ? field.thumbs : [];
  if (
    thumb !== "" &&
    (DEFAULT_THUMB_SIZES.includes(thumb) || thumbsOf.includes(thumb))
  ) {
    const original = await readFile(e, originalKey);
    if (!original) throw new ApiError(404, "");
    originalType = original.type ?? (await sniffMime(original.blob));
    if (THUMB_TYPES.has(originalType)) {
      served.servedName = `${thumb}_${filename}`;
      served.servedPath = fileKey(
        base.collectionId,
        base.recordId,
        `thumbs_${filename}/${served.servedName}`,
      );
      if (!(await readFile(e, served.servedPath))) {
        try {
          if (e.req.signal.aborted) throw new Error("the request was aborted");
          await generateThumb(
            e.app.files,
            originalKey,
            served.servedPath,
            thumb,
          );
          if (!(await e.app.files.file(originalKey))) {
            await e.app.files.deletePrefix(
              fileKey(base.collectionId, base.recordId, `thumbs_${filename}/`),
            );
            throw new ApiError(404, "");
          }
        } catch (err) {
          if (err instanceof ApiError) throw err;
          e.app.logger.warn(
            `Fallback to original - failed to create thumb ${served.servedName}`,
            { error: err },
          );
          served.thumbError = err as Error;
          served.servedName = filename;
          served.servedPath = originalKey;
        }
      }
    }
  }
  if (thumb !== "" && !served.thumbError && served.servedPath === originalKey)
    served.thumbError = new Error(
      `the thumb size "${thumb}" or the original file format are not supported`,
    );

  e.responseHeaders.delete("x-frame-options");
  const hook = e.app.hooks.onFileDownloadRequest;
  const serveOne = (fe: RequestEvent, s: typeof served) =>
    serve(fe, s, s.servedPath === originalKey ? originalType : undefined);
  if (hook.length === 0) return serveOne(e, served);
  const event = FileDownloadRequestEvent.from(e, {
    collection: c,
    record: new RecordModel(c, record, false),
    fileField: field,
    ...served,
  });
  await hook.trigger(event, (fe) => serveOne(fe, fe));
}

async function serve(
  e: RequestEvent,
  { servedPath, servedName }: { servedPath: string; servedName: string },
  type?: string,
): Promise<void> {
  try {
    await serveStoredFile(e, e.app.files, servedPath, servedName, type);
  } catch {
    throw new ApiError(404, "");
  }
}

const TYPE_CACHE_SIZE = 4096;
const typeCaches = new WeakMap<
  Filesystem,
  Map<string, { size: number; modified: number; type: string }>
>();

// sniffing is a large part of a download, so the type is kept per key while size and mtime match
async function cachedSniff(fs: Filesystem, key: string, file: StoredFile) {
  let cache = typeCaches.get(fs);
  if (!cache) typeCaches.set(fs, (cache = new Map()));
  const modified = file.modified.getTime();
  const hit = cache.get(key);
  if (hit && hit.size === file.size && hit.modified === modified) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.type;
  }
  const type = await sniffMime(file.blob);
  cache.delete(key);
  if (cache.size >= TYPE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, { size: file.size, modified, type });
  return type;
}

// Port of PB filesystem.Serve
export async function serveStoredFile(
  e: RequestEvent,
  fs: Filesystem,
  key: string,
  name: string,
  sniffed?: string,
): Promise<void> {
  const file = fs.open
    ? await fs.open(key, needsStat(e.req))
    : await fs.file(key);
  if (!file) throw new NotFoundError();
  const type =
    sniffed ?? ("read" in file ? file.type : await cachedSniff(fs, key, file));
  const inline =
    !TRUE.has(e.query.get("download") ?? "") && INLINE_TYPES.has(type);
  const headers = new Headers({
    "content-disposition": `${inline ? "inline" : "attachment"}; filename=${JSON.stringify(name)}`,
    "content-type": EXTENSION_TYPES[extensionOf(key)] ?? type,
    "content-security-policy":
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "max-age=2592000, stale-while-revalidate=86400",
  });
  e.response = await serveContent(e.req, file, headers);
}

// A remote file is opened with one GET for a plain GET; otherwise its stat comes first so
// HEAD, 304, 412 and 416 never start a body request and ranges get their own GETs.
const needsStat = (req: Request) =>
  req.method !== "GET" ||
  [
    "range",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
  ].some((h) => req.headers.has(h));

const SMALL_BODY = 64 << 10;

// Bun.serve drops Content-Length for a stream body, so a stream that ends within SMALL_BODY becomes a Blob.
async function settle(
  source: ReadableStream<Uint8Array>,
): Promise<Blob | ReadableStream<Uint8Array>> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  while (read <= SMALL_BODY) {
    const { done, value } = await reader.read();
    if (done) return new Blob([Buffer.concat(chunks)]);
    chunks.push(value);
    read += value.length;
  }
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
    },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

// the pieces one after another, each stream opened when the previous one ends
function concat(
  pieces: (() => ReadableStream<Uint8Array>)[],
): ReadableStream<Uint8Array> {
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      for (;;) {
        if (!reader) {
          if (next === pieces.length) return c.close();
          reader = pieces[next++]!().getReader();
        }
        const { done, value } = await reader.read();
        if (!done) return c.enqueue(value);
        reader = undefined;
      }
    },
    cancel: (reason) => reader?.cancel(reason),
  });
}

type Served = StoredFile | RemoteFile;

const release = (file: Served) => {
  if ("read" in file) file.close();
};

interface ByteRange {
  start: number;
  length: number;
}

const NO_OVERLAP = "invalid range: failed to overlap";
const MAX_INT64 = 2n ** 63n - 1n;

// textproto.TrimString
const trim = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");

// strconv.ParseInt(s, 10, 64); NaN where Go returns an error
function parseInt64(s: string): number {
  if (!/^[+-]?\d+$/.test(s)) return NaN;
  const n = BigInt(s);
  return n > MAX_INT64 || n < -MAX_INT64 - 1n ? NaN : Number(n);
}

// Port of Go's net/http parseRange.
function parseRange(header: string, size: number): ByteRange[] {
  if (header === "") return [];
  if (!header.startsWith("bytes=")) throw new Error("invalid range");
  const ranges: ByteRange[] = [];
  let noOverlap = false;
  for (const raw of header.slice(6).split(",")) {
    const part = trim(raw);
    if (part === "") continue;
    const dash = part.indexOf("-");
    if (dash < 0) throw new Error("invalid range");
    const from = trim(part.slice(0, dash));
    const to = trim(part.slice(dash + 1));
    if (from === "") {
      if (to === "" || to[0] === "-") throw new Error("invalid range");
      const n = parseInt64(to);
      if (!(n >= 0)) throw new Error("invalid range");
      const start = size - Math.min(n, size);
      ranges.push({ start, length: size - start });
      continue;
    }
    const start = parseInt64(from);
    if (!(start >= 0)) throw new Error("invalid range");
    if (start >= size) {
      noOverlap = true;
      continue;
    }
    if (to === "") {
      ranges.push({ start, length: size - start });
      continue;
    }
    const end = parseInt64(to);
    if (Number.isNaN(end) || start > end) throw new Error("invalid range");
    ranges.push({ start, length: Math.min(end, size - 1) - start + 1 });
  }
  if (noOverlap && ranges.length === 0) throw new Error(NO_OVERLAP);
  return ranges;
}

const httpSeconds = (value: string) => Math.floor(Date.parse(value) / 1000);

function scanETag(value: string): [string, string] {
  const s = trim(value);
  const start = s.startsWith("W/") ? 2 : 0;
  if (s.length - start < 2 || s[start] !== '"') return ["", ""];
  for (let i = start + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) return [s.slice(0, i + 1), s.slice(i + 1)];
    if (!(c === 0x21 || (c >= 0x23 && c <= 0x7e) || c >= 0x80)) return ["", ""];
  }
  return ["", ""];
}

// Go's If-Match / If-None-Match walk against a response without an ETag (PB sets none):
// only a "*" met before a malformed entry matches.
function listHasStar(list: string): boolean {
  for (let s = list; ;) {
    s = trim(s);
    if (s === "") return false;
    if (s[0] === ",") {
      s = s.slice(1);
      continue;
    }
    if (s[0] === "*") return true;
    const [etag, rest] = scanETag(s);
    if (etag === "") return false;
    s = rest;
  }
}

function notModified(headers: Headers): Response {
  headers.delete("content-type");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(null, { status: 304, headers });
}

// Go's serveError for a 416
function rangeError(message: string, headers: Headers): Response {
  const failed = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  for (const [k, v] of headers)
    if (!["last-modified", "content-type", "cache-control"].includes(k))
      failed.set(k, v);
  return new Response(`${message}\n`, { status: 416, headers: failed });
}

// Go's checkPreconditions: the response that ends the request, or the Range header to serve.
function checkPreconditions(
  req: Request,
  modified: number,
  headers: Headers,
): Response | string {
  const getOrHead = req.method === "GET" || req.method === "HEAD";
  const ifMatch = req.headers.get("if-match");
  let ok: boolean | null = ifMatch ? listHasStar(ifMatch) : null;
  const ius = req.headers.get("if-unmodified-since");
  if (ok === null && ius && modified > 0) {
    const t = httpSeconds(ius);
    if (!Number.isNaN(t)) ok = modified <= t;
  }
  if (ok === false) return new Response(null, { status: 412, headers });

  const inm = req.headers.get("if-none-match");
  if (inm) {
    if (listHasStar(inm))
      return getOrHead
        ? notModified(headers)
        : new Response(null, { status: 412, headers });
  } else {
    const ims = req.headers.get("if-modified-since");
    const t = getOrHead && ims && modified > 0 ? httpSeconds(ims) : NaN;
    if (modified <= t) return notModified(headers);
  }

  const range = req.headers.get("range") ?? "";
  const ifRange = req.headers.get("if-range");
  if (range && getOrHead && ifRange) {
    const matches =
      scanETag(ifRange)[0] === "" &&
      modified !== 0 &&
      httpSeconds(ifRange) === modified;
    if (!matches) return "";
  }
  return range;
}

const contentRange = (r: ByteRange, size: number) =>
  `bytes ${r.start}-${r.start + r.length - 1}/${size}`;

function randomBoundary(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(30))).toString(
    "hex",
  );
}

// Port of Go's net/http serveContent as PB's file route uses it (Content-Type always set).
async function serveContent(
  req: Request,
  file: Served,
  headers: Headers,
): Promise<Response> {
  const { size } = file;
  const modified = Math.floor(file.modified.getTime() / 1000);
  if (modified > 0)
    headers.set("last-modified", new Date(modified * 1000).toUTCString());

  const checked = checkPreconditions(req, modified, headers);
  if (checked instanceof Response) {
    release(file);
    return checked;
  }

  let ranges: ByteRange[];
  try {
    ranges = parseRange(checked, size);
  } catch (err) {
    const message = (err as Error).message;
    if (message !== NO_OVERLAP || size !== 0) {
      release(file);
      if (message === NO_OVERLAP)
        headers.set("content-range", `bytes */${size}`);
      return rangeError(message, headers);
    }
    ranges = [];
  }
  if (ranges.reduce((n, r) => n + r.length, 0) > size) ranges = [];

  const head = req.method === "HEAD";
  let status = 200;
  let length = size;
  let body = async (): Promise<BodyInit> =>
    "read" in file ? settle(file.read(0, size)) : file.blob;

  if (ranges.length === 1) {
    const r = ranges[0]!;
    status = 206;
    length = r.length;
    headers.set("content-range", contentRange(r, size));
    body = async () =>
      "read" in file
        ? settle(file.read(r.start, r.length))
        : file.blob.slice(r.start, r.start + r.length);
  } else if (ranges.length > 1) {
    status = 206;
    const boundary = randomBoundary();
    const ctype = headers.get("content-type") ?? "";
    const parts: (string | ByteRange)[] = [];
    ranges.forEach((r, i) => {
      parts.push(
        `${i > 0 ? "\r\n" : ""}--${boundary}\r\nContent-Range: ${contentRange(r, size)}\r\nContent-Type: ${ctype}\r\n\r\n`,
        r,
      );
    });
    parts.push(`\r\n--${boundary}--\r\n`);
    length = parts.reduce(
      (n, p) => n + (typeof p === "string" ? Buffer.byteLength(p) : p.length),
      0,
    );
    headers.set("content-type", `multipart/byteranges; boundary=${boundary}`);
    body = async () => {
      if ("read" in file)
        return settle(
          concat(
            parts.map((p) =>
              typeof p === "string"
                ? () => new Blob([p]).stream()
                : () => file.read(p.start, p.length),
            ),
          ),
        );
      return new Blob(
        await Promise.all(
          parts.map((p) =>
            typeof p === "string"
              ? p
              : file.blob.slice(p.start, p.start + p.length).bytes(),
          ),
        ),
      );
    };
  }

  headers.set("accept-ranges", "bytes");
  headers.set("content-length", String(length));
  if (head) {
    release(file);
    return new Response(null, { status, headers });
  }
  return new Response(await body(), { status, headers });
}

export function registerFileRoutes(router: Router): void {
  router.route("POST", "/api/files/token", (e) => {
    if (!e.auth)
      throw new ApiError(
        401,
        "The request requires valid record authorization token.",
      );
    const { collection, record } = e.auth;
    const token = newFileToken(e.app, collection, record);
    const hook = e.app.hooks.onFileTokenRequest;
    if (hook.length === 0) return e.json(200, { token });
    const event = FileTokenRequestEvent.from(e, {
      record: new RecordModel(collection, record, false),
      token,
    });
    return hook.trigger(event, (te) => {
      te.json(200, { token: te.token });
    });
  });
  router.route(
    "GET",
    "/api/files/{collection}/{recordId}/{filename}",
    download,
    collectionPathRateLimit("collection", "file"),
  );
}
