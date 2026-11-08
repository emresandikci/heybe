import { newFileToken, authFromToken } from "../../auth/tokens";
import type { Collection } from "../../collections/model";
import { findRecordByViewFile } from "../../collections/view";
import { uniqueStrings } from "../../fields/shared";
import { sniffMime } from "../../files/mime";
import { fileKey } from "../../files/storage";
import { createThumb, thumbGenerator } from "../../files/thumbs";
import { buildRequestInfo, ruleFilter } from "../../records/rules";
import { ApiError } from "../errors";
import { checkSuperuserIp, framable } from "../middlewares";
import type { RequestEvent, Router } from "../router";

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

async function download(e: RequestEvent): Promise<Response> {
  const c = e.app.collections.find(e.params.collection!);
  if (!c) throw new ApiError(404, "Missing or invalid collection context.");

  let record: Record<string, unknown>;
  try {
    record = e.app.records(c.name).findRaw(e.params.recordId!);
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
  let servedName = filename;
  let blob: Blob | null;
  try {
    blob = await e.app.files.file(originalKey);
  } catch {
    blob = null;
  }
  if (!blob) throw new ApiError(404, "");

  const thumb = e.query.get("thumb") ?? "";
  const thumbsOf = Array.isArray(field.thumbs) ? field.thumbs : [];
  if (
    thumb !== "" &&
    (DEFAULT_THUMB_SIZES.includes(thumb) || thumbsOf.includes(thumb)) &&
    THUMB_TYPES.has(await sniffMime(blob))
  ) {
    const thumbName = `${thumb}_${filename}`;
    const thumbKey = fileKey(
      base.collectionId,
      base.recordId,
      `thumbs_${filename}/${thumbName}`,
    );
    let thumbBlob = await e.app.files.file(thumbKey).catch(() => null);
    if (!thumbBlob) {
      try {
        await generateThumb(e.app.files, originalKey, thumbKey, thumb);
        if (await e.app.files.file(originalKey)) {
          thumbBlob = await e.app.files.file(thumbKey);
        } else {
          await e.app.files.deletePrefix(
            fileKey(base.collectionId, base.recordId, `thumbs_${filename}`),
          );
          throw new ApiError(404, "");
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        console.warn(
          `Fallback to original - failed to create thumb ${thumbName}`,
          err,
        );
      }
    }
    if (thumbBlob) {
      blob = thumbBlob;
      servedName = thumbName;
    }
  }

  const type = await sniffMime(blob);
  const inline =
    !TRUE.has(e.query.get("download") ?? "") && INLINE_TYPES.has(type);
  const headers = new Headers({
    "content-disposition": `${inline ? "inline" : "attachment"}; filename=${JSON.stringify(servedName)}`,
    "content-type": EXTENSION_TYPES[extensionOf(servedName)] ?? type,
    "content-security-policy":
      "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "max-age=2592000, stale-while-revalidate=86400",
  });
  const res = serveContent(e.req, blob, headers);
  framable.add(res);
  return res;
}

const NO_OVERLAP = "invalid range: failed to overlap";

// Single range of Go's http.parseRange; null when the header asks for none or several.
function parseRange(
  header: string,
  size: number,
): { start: number; length: number } | null {
  if (!header.startsWith("bytes=")) throw new Error("invalid range");
  const ranges: { start: number; length: number }[] = [];
  let noOverlap = false;
  const parts = header
    .slice(6)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const part of parts) {
    const dash = part.indexOf("-");
    if (dash < 0) throw new Error("invalid range");
    const from = part.slice(0, dash).trim();
    const to = part.slice(dash + 1).trim();
    const int = (v: string) => (/^[+-]?\d+$/.test(v) ? Number(v) : NaN);
    if (from === "") {
      const n = int(to);
      if (to === "" || to.startsWith("-") || !(n >= 0))
        throw new Error("invalid range");
      const length = Math.min(n, size);
      ranges.push({ start: size - length, length });
      continue;
    }
    const start = int(from);
    if (!(start >= 0)) throw new Error("invalid range");
    if (start >= size) {
      noOverlap = true;
      continue;
    }
    if (to === "") {
      ranges.push({ start, length: size - start });
      continue;
    }
    const end = int(to);
    if (!(end >= start)) throw new Error("invalid range");
    ranges.push({ start, length: Math.min(end, size - 1) - start + 1 });
  }
  if (noOverlap && ranges.length === 0) throw new Error(NO_OVERLAP);
  const total = ranges.reduce((n, r) => n + r.length, 0);
  return ranges.length === 1 && total <= size ? ranges[0]! : null;
}

// The parts of Go's http.ServeContent that PB's file route relies on.
function serveContent(req: Request, blob: Blob, headers: Headers): Response {
  const size = blob.size;
  const modified = Math.floor(((blob as Bun.BunFile).lastModified ?? 0) / 1000);
  const lastModified = new Date(modified * 1000).toUTCString();
  const readOnly = req.method === "GET" || req.method === "HEAD";
  if (modified > 0) headers.set("last-modified", lastModified);

  const since = Date.parse(req.headers.get("if-modified-since") ?? "");
  if (
    readOnly &&
    modified > 0 &&
    !Number.isNaN(since) &&
    modified <= since / 1000
  ) {
    headers.delete("content-type");
    return new Response(null, { status: 304, headers });
  }

  let range = readOnly ? (req.headers.get("range") ?? "") : "";
  const ifRange = req.headers.get("if-range");
  if (range && ifRange && Date.parse(ifRange) / 1000 !== modified) range = "";

  let selected: ReturnType<typeof parseRange> = null;
  if (range) {
    try {
      selected = parseRange(range, size);
    } catch (err) {
      const message = (err as Error).message;
      const failed = new Headers({
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      for (const [k, v] of headers)
        if (!["last-modified", "content-type", "cache-control"].includes(k))
          failed.set(k, v);
      if (message === NO_OVERLAP)
        failed.set("content-range", `bytes */${size}`);
      return new Response(`${message}\n`, { status: 416, headers: failed });
    }
  }

  headers.set("accept-ranges", "bytes");
  if (!selected) return new Response(blob, { headers });
  const { start, length } = selected;
  headers.set("content-range", `bytes ${start}-${start + length - 1}/${size}`);
  return new Response(blob.slice(start, start + length), {
    status: 206,
    headers,
  });
}

export function registerFileRoutes(router: Router): void {
  router.add("POST", "/api/files/token", (e) => {
    if (!e.auth)
      throw new ApiError(
        401,
        "The request requires valid record authorization token.",
      );
    return e.json(200, {
      token: newFileToken(e.app, e.auth.collection, e.auth.record),
    });
  });
  router.add("GET", "/api/files/{collection}/{recordId}/{filename}", download);
}
