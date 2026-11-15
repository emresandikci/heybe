import { open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./errors";
import { checkBodyLimit } from "./middlewares";

const JSON_PAYLOAD = "@jsonPayload";
const NUMBER_CHARS = /^[-.\d]+$/;
// Go mime/multipart limits: parts, header values, a line of the 4096 bytes read buffer, file bytes
// kept in memory (PB DefaultMaxMemory) and 10 MB more for plain values
const MAX_PARTS = 1000;
const MAX_HEADERS = 10000;
const MAX_LINE = 4096;
const MAX_MEMORY = 16 << 20;
const MAX_VALUE_MEMORY = MAX_MEMORY + (10 << 20);
const MAP_ENTRY_OVERHEAD = 200;
const FILE_HEADER_SIZE = 100;
const MIME_TOKEN = /^[!#$%&'*+\-.^_`{|}~0-9A-Za-z]+/;
const HEADER_KEY = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TSPECIALS = `()<>@,;:\\"/[]?=`;

const fail = (): never => {
  throw new ApiError(400, "");
};

// Go strconv.FormatFloat(v, 'f', -1, 64): the shortest digits, never an exponent
function formatFloat(n: number): string {
  if (Object.is(n, -0)) return "-0";
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = m[2] + (m[3] ?? "");
  const exp = Number(m[4]);
  return exp > 0
    ? m[1] + digits.padEnd(exp + 1, "0")
    : `${m[1]}0.${"0".repeat(-exp - 1)}${digits}`;
}

// Port of PB router inferValue: plain multipart values become bools and numbers when they round trip.
export function inferValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && /^[-\d]/.test(raw) && NUMBER_CHARS.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && formatFloat(n) === raw) return n;
  }
  return raw;
}

// Go mime consumeValue: a token or a quoted string; null when there is none.
function consumeValue(v: string): [string, string] | null {
  if (v[0] !== '"') {
    const token = MIME_TOKEN.exec(v)?.[0] ?? "";
    return token ? [token, v.slice(token.length)] : null;
  }
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (c === '"') return [out, v.slice(i + 1)];
    if (c === "\\" && i + 1 < v.length && TSPECIALS.includes(v[i + 1])) {
      out += v[++i];
      continue;
    }
    if (c === "\r" || c === "\n") return null;
    out += c;
  }
  return null;
}

// Go mime decode2231Enc: `charset'lang'percent-encoded`, utf-8 and us-ascii only.
function decode2231(v: string): string | null {
  const parts = v.split("'");
  if (parts.length !== 3) return null;
  const charset = parts[0].toLowerCase();
  if (charset !== "us-ascii" && charset !== "utf-8") return null;
  return unescapeHex(parts[2]);
}

function unescapeHex(v: string): string | null {
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}

// Port of Go mime.ParseMediaType; null on any error.
function parseMediaType(
  v: string,
): { type: string; params: Map<string, string> } | null {
  const semi = v.indexOf(";");
  const type = (semi < 0 ? v : v.slice(0, semi)).trim().toLowerCase();
  if (!/^[^/]+(\/[^/]+)?$/.test(type)) return null;
  if (!type.split("/").every((t) => MIME_TOKEN.exec(t)?.[0] === t)) return null;

  const params = new Map<string, string>();
  const starred = new Map<string, Map<string, string>>();
  let rest = semi < 0 ? "" : v.slice(semi);
  for (;;) {
    rest = rest.trimStart();
    if (rest === "") break;
    const m = /^;\s*([!#$%&'*+\-.^_`{|}~0-9A-Za-z]+)\s*=\s*/.exec(rest);
    const value = m ? consumeValue(rest.slice(m[0].length)) : null;
    if (!m || !value) {
      if (rest.trim() === ";") break;
      return null;
    }
    const key = m[1].toLowerCase();
    let map = params;
    const star = key.indexOf("*");
    if (star >= 0) {
      const base = key.slice(0, star);
      if (!starred.has(base)) starred.set(base, new Map());
      map = starred.get(base)!;
    }
    if (map.has(key) && map.get(key) !== value[0]) return null;
    map.set(key, value[0]);
    rest = value[1];
  }
  for (const [key, pieces] of starred) {
    const single = pieces.get(`${key}*`);
    if (single !== undefined) {
      const decoded = decode2231(single);
      if (decoded !== null) params.set(key, decoded);
      continue;
    }
    let out = "";
    let valid = false;
    for (let n = 0; ; n++) {
      const plain = pieces.get(`${key}*${n}`);
      if (plain !== undefined) {
        valid = true;
        out += plain;
        continue;
      }
      const encoded = pieces.get(`${key}*${n}*`);
      if (encoded === undefined) break;
      valid = true;
      out += (n === 0 ? decode2231(encoded) : unescapeHex(encoded)) ?? "";
    }
    if (valid) params.set(key, out);
  }
  return { type, params };
}

// Go filepath.Base on unix
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

// The temp files of the spilled parts of one request. Once removed, a part that spills later (from
// a body read the request did not wait for) is deleted at once.
export class TempFiles {
  private readonly paths: string[] = [];
  private closed = false;

  add(path: string): boolean {
    if (!this.closed) this.paths.push(path);
    return !this.closed;
  }

  async removeAll(): Promise<void> {
    this.closed = true;
    const paths = this.paths.splice(0);
    await Promise.all(paths.map((path) => rm(path, { force: true })));
  }
}

class BodyReader {
  buf: Buffer = Buffer.alloc(0);
  pos = 0;
  eof = false;
  private size = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly limit: number;

  constructor(body: ReadableStream<Uint8Array>, limit: number) {
    this.reader = body.getReader();
    this.limit = limit;
  }

  async fill(): Promise<boolean> {
    if (this.eof) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.eof = true;
      return false;
    }
    this.size += value.length;
    if (this.size > this.limit) {
      await this.reader.cancel();
      throw new ApiError(413, "Request entity too large");
    }
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.length);
    this.buf =
      this.pos === this.buf.length
        ? chunk
        : Buffer.concat([this.buf.subarray(this.pos), chunk]);
    this.pos = 0;
    return true;
  }

  // A line with its "\n" of at most `max` bytes, or what is left at the end of the body. Each chunk
  // is scanned once and the pieces are joined once.
  async line(max: number): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let size = 0;
    for (;;) {
      const i = this.buf.indexOf(10, this.pos);
      const end = i >= 0 ? i + 1 : this.buf.length;
      size += end - this.pos;
      if (size > max || (i < 0 && size >= max)) fail();
      pieces.push(this.buf.subarray(this.pos, end));
      this.pos = end;
      if (i >= 0 || !(await this.fill()))
        return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
    }
  }

  // Go multipart scanUntilBoundary: part bytes up to a `delim` followed by space, a newline or "--".
  async part(
    delim: Buffer,
    emit: (bytes: Buffer) => void | Promise<void>,
  ): Promise<void> {
    for (;;) {
      const i = this.buf.indexOf(delim, this.pos);
      if (i >= 0) {
        const after = i + delim.length;
        if (this.buf.length < after + 2 && (await this.fill())) continue;
        if (endsPart(this.buf, after, this.eof)) {
          await emit(this.buf.subarray(this.pos, i));
          this.pos = i;
          return;
        }
        await emit(this.buf.subarray(this.pos, i + 1));
        this.pos = i + 1;
        continue;
      }
      const safe = Math.max(this.pos, this.buf.length - delim.length + 1);
      await emit(this.buf.subarray(this.pos, safe));
      this.pos = safe;
      if (!(await this.fill())) fail();
    }
  }
}

// Go multipart matchAfterPrefix
function endsPart(buf: Buffer, at: number, eof: boolean): boolean {
  if (at === buf.length) return eof;
  const c = buf[at];
  if (c === 32 || c === 9 || c === 13 || c === 10) return true;
  return c === 45 && buf[at + 1] === 45;
}

const skipSpace = (s: string) => s.replace(/^[ \t]+/, "");

// Go textproto ReadMIMEHeader within the memory budget: first value of each key, lower-cased keys.
async function readHeaders(
  body: BodyReader,
  maxBytes: number,
  maxHeaders: number,
): Promise<Map<string, string>> {
  const lines: [string, string][] = [];
  let size = 0;
  for (;;) {
    const raw = await body.line(Math.max(maxBytes - size, 1));
    size += raw.length;
    if (raw[raw.length - 1] !== 10 || size > maxBytes) fail();
    const line = raw.toString("utf8").replace(/\r?\n$/, "");
    if (line === "") break;
    if (line[0] === " " || line[0] === "\t") {
      if (lines.length === 0) fail();
      lines[lines.length - 1][1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).toLowerCase();
    if (colon <= 0 || !HEADER_KEY.test(key)) fail();
    if (lines.length >= maxHeaders) fail();
    lines.push([key, line.slice(colon + 1)]);
  }
  const headers = new Map<string, string>();
  for (const [k, v] of lines)
    if (!headers.has(k)) headers.set(k, v.replace(/^[ \t]+|[ \t]+$/g, ""));
  return headers;
}

async function writeAll(fh: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length;)
    off += (await fh.write(bytes, off)).bytesWritten;
}

const one = (values: unknown[]) => (values.length === 1 ? values[0] : values);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Go url.Values and multipart.Form: the plain values (`@jsonPayload` included) and the files by key.
export interface Form {
  values: Map<string, string[]>;
  files: Map<string, File[]>;
}

export const emptyForm = (): Form => ({ values: new Map(), files: new Map() });

// Go quotedprintable.Reader for one line, with its "\n" when it has one.
function decodeQPLine(whole: Buffer, last: boolean): Buffer {
  let end = whole.length;
  while (end > 0 && [10, 13, 32, 9].includes(whole[end - 1])) end--;
  let line = whole.subarray(0, end);
  const stripped = whole.subarray(end);
  let tail = "";
  if (line[line.length - 1] === 61) {
    line = line.subarray(0, -1);
    const soft =
      stripped[0] === 10 ||
      (stripped[0] === 13 && stripped[1] === 10) ||
      (stripped.length === 0 && line.length > 0 && last);
    if (!soft) fail();
  } else if (whole[whole.length - 1] === 10) {
    tail = whole[whole.length - 2] === 13 ? "\r\n" : "\n";
  }
  const bytes = Buffer.concat([line, Buffer.from(tail)]);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 61) {
      const hex = bytes.subarray(i + 1, i + 3).toString("latin1");
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else if (
        bytes.length - i >= 2 &&
        bytes[i + 1] !== 13 &&
        bytes[i + 1] !== 10
      )
        out.push(b);
      else fail();
    } else if (b === 9 || b === 10 || b === 13 || b >= 0x80) out.push(b);
    else if (b < 0x20 || b > 0x7e) fail();
    else out.push(b);
  }
  return Buffer.from(out);
}

// A quoted-printable part decoded line by line (Go multipart decodes them transparently).
async function quotedPrintablePart(
  body: BodyReader,
  delim: Buffer,
  emit: (bytes: Buffer) => void | Promise<void>,
): Promise<void> {
  let pending: Buffer = Buffer.alloc(0);
  await body.part(delim, async (bytes) => {
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    let start = 0;
    for (let i = pending.indexOf(10); i >= 0; i = pending.indexOf(10, start)) {
      if (i - start >= MAX_LINE) fail();
      await emit(decodeQPLine(pending.subarray(start, i + 1), false));
      start = i + 1;
    }
    pending = pending.subarray(start);
    if (pending.length >= MAX_LINE) fail();
  });
  if (pending.length > 0) await emit(decodeQPLine(pending, true));
}

// Port of Go multipart Reader.ReadForm over the streamed body, within `limit` bytes. File parts stay
// in memory up to MAX_MEMORY in total, later ones go to temp files added to `temp`. Like PB's, a
// spilled `File` reads its temp file lazily, so it is valid only until the request removes them.
export async function readMultipart(
  req: Request,
  limit: number,
  temp: TempFiles,
): Promise<Form> {
  checkBodyLimit(req, limit);
  const form = emptyForm();
  if (!req.body) return form;
  const body = new BodyReader(req.body, limit);
  if (!(await body.fill())) return form;

  const media = parseMediaType(req.headers.get("content-type") ?? "");
  const boundary = media?.params.get("boundary");
  if (media?.type !== "multipart/form-data" || !boundary) fail();
  const dash = Buffer.from(`--${boundary}`).toString("latin1");
  let nl = "\r\n";
  let partsRead = 0;

  const isDelimiter = (line: string) => {
    if (!line.startsWith(dash)) return false;
    const rest = skipSpace(line.slice(dash.length));
    if (partsRead === 0 && rest === "\n") nl = "\n";
    return rest === nl;
  };
  const isFinal = (line: string) => {
    if (!line.startsWith(`${dash}--`)) return false;
    const rest = skipSpace(line.slice(dash.length + 2));
    return rest === "" || rest === nl;
  };
  // Go multipart Reader.NextPart: true when a part follows, false at the final boundary
  const nextPart = async () => {
    let expectNewPart = false;
    for (;;) {
      const raw = await body.line(MAX_LINE);
      const line = raw.toString("latin1");
      if (!line.endsWith("\n")) return isFinal(line) ? false : fail();
      if (isDelimiter(line)) {
        partsRead++;
        return true;
      }
      if (isFinal(line)) return false;
      if (expectNewPart) fail();
      if (partsRead === 0) continue;
      if (line === nl) {
        expectNewPart = true;
        continue;
      }
      fail();
    }
  };

  const { values, files } = form;
  let memory = MAX_VALUE_MEMORY;
  let fileMemory = MAX_MEMORY;
  let maxHeaders = MAX_HEADERS;
  let parts = 0;
  while (await nextPart()) {
    const headers = await readHeaders(body, memory, maxHeaders);
    if (++parts > MAX_PARTS) fail();
    const delim = Buffer.from(nl + dash, "latin1");
    const disposition = parseMediaType(
      headers.get("content-disposition") ?? "",
    );
    const name =
      disposition?.type === "form-data"
        ? (disposition.params.get("name") ?? "")
        : "";
    const qp =
      headers.get("content-transfer-encoding")?.toLowerCase() ===
      "quoted-printable";
    const read = (emit: (bytes: Buffer) => void | Promise<void>) =>
      qp ? quotedPrintablePart(body, delim, emit) : body.part(delim, emit);
    if (name === "") {
      await read(() => {});
      continue;
    }
    const rawFilename = disposition!.params.get("filename") ?? "";
    memory -= Buffer.byteLength(name) + MAP_ENTRY_OVERHEAD;
    if (memory < 0) fail();

    const chunks: Buffer[] = [];
    let size = 0;
    if (rawFilename === "") {
      await read((bytes) => {
        size += bytes.length;
        if (size > memory) fail();
        chunks.push(bytes);
      });
      memory -= size;
      push(values, name, Buffer.concat(chunks).toString("utf8"));
      continue;
    }

    for (const [k, v] of headers) {
      memory -=
        Buffer.byteLength(k) + Buffer.byteLength(v) + MAP_ENTRY_OVERHEAD;
      maxHeaders--;
    }
    memory -= MAP_ENTRY_OVERHEAD + FILE_HEADER_SIZE;
    if (memory < 0) fail();
    const disk = { path: "", fh: null as FileHandle | null };
    try {
      await read(async (bytes) => {
        if (disk.fh) return writeAll(disk.fh, bytes);
        size += bytes.length;
        chunks.push(bytes);
        if (size <= fileMemory) return;
        const path = join(tmpdir(), `heybe-upload-${crypto.randomUUID()}`);
        disk.fh = await open(path, "wx", 0o600);
        disk.path = path;
        if (!temp.add(path)) {
          await rm(path, { force: true });
          fail();
        }
        for (const c of chunks.splice(0)) await writeAll(disk.fh, c);
      });
    } finally {
      await disk.fh?.close();
    }
    const type = headers.get("content-type") ?? "";
    const filename = baseName(rawFilename);
    if (disk.path) {
      push(files, name, new File([Bun.file(disk.path)], filename, { type }));
      continue;
    }
    fileMemory -= size;
    memory -= size;
    push(files, name, new File([Buffer.concat(chunks)], filename, { type }));
  }
  return form;
}

// Port of PB UnmarshalRequestData into a map: plain values are inferred and come first, then the
// `@jsonPayload` objects are merged over them; file parts are appended to their key as `File` values.
export function formBody({ values, files }: Form): Record<string, unknown> {
  const fresh = () => Object.create(null) as Record<string, unknown>;
  const set = (o: Record<string, unknown>, k: string, v: unknown) =>
    Object.defineProperty(o, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  let out = fresh();
  for (const [key, list] of values)
    if (key !== JSON_PAYLOAD) set(out, key, one(list.map(inferValue)));
  for (const payload of values.get(JSON_PAYLOAD) ?? []) {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new ApiError(400, "");
    }
    // Go's json.Unmarshal of null into the body map resets it
    if (data === null) {
      out = fresh();
      continue;
    }
    if (typeof data !== "object" || Array.isArray(data))
      throw new ApiError(400, "");
    for (const [k, v] of Object.entries(data)) set(out, k, v);
  }
  for (const [key, list] of files) {
    const prev = out[key];
    set(
      out,
      key,
      prev === undefined
        ? one(list)
        : [...(Array.isArray(prev) ? prev : [prev]), ...list],
    );
  }
  return out;
}

export async function parseMultipart(
  req: Request,
  limit: number,
  temp: TempFiles,
): Promise<Record<string, unknown>> {
  const form = await readMultipart(req, limit, temp);
  return form.values.size + form.files.size === 0 ? {} : formBody(form);
}

const REQUEST_FILE = /^requests(?:\.(0|[1-9]\d*)\.|\[(0|[1-9]\d*)\]\.)/;

// Port of PB extractPrefixedFiles for all batch requests in one pass: the files under
// `requests.N.key` or `requests[N].key`, by N and key.
export function requestFiles(
  form: Record<string, unknown>,
): Map<number, Map<string, File[]>> {
  const out = new Map<number, Map<string, File[]>>();
  for (const [key, value] of Object.entries(form)) {
    const m = REQUEST_FILE.exec(key);
    if (!m) continue;
    const index = Number(m[1] ?? m[2]);
    for (const v of Array.isArray(value) ? value : [value]) {
      if (!(v instanceof File)) continue;
      if (!out.has(index)) out.set(index, new Map());
      push(out.get(index)!, key.slice(m[0].length), v);
    }
  }
  return out;
}
