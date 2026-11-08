import { ApiError } from "./errors";
import { readLimited } from "./middlewares";

const JSON_PAYLOAD = "@jsonPayload";
const NUMBER_CHARS = /^[-.\d]+$/;
// Go's multipart reader rejects forms with more parts
const MAX_PARTS = 1000;

// Port of PB router inferValue: plain multipart values become bools and numbers when they round trip.
function inferValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && /^[-\d]/.test(raw) && NUMBER_CHARS.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && String(n) === raw) return n;
  }
  return raw;
}

const one = (values: unknown[]) => (values.length === 1 ? values[0] : values);

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// Reads a multipart body within `limit` bytes. Plain values come first, then the `@jsonPayload`
// objects are merged over them; file parts are appended to their key as `File` values.
export async function parseMultipart(
  req: Request,
  limit: number,
): Promise<Record<string, unknown>> {
  const bytes = await readLimited(req, limit);
  if (bytes.length === 0) return {};

  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new ApiError(400, "");
  }

  const plain = new Map<string, unknown[]>();
  const payloads: string[] = [];
  const files = new Map<string, File[]>();
  let parts = 0;
  for (const [key, entry] of form.entries()) {
    if (++parts > MAX_PARTS) throw new ApiError(400, "");
    const value = entry as string | File;
    // a part without a filename is a plain value in Go's multipart reader
    if (typeof value !== "string" && value.name) {
      push(files, key, value);
      continue;
    }
    const text = typeof value === "string" ? value : await value.text();
    if (key === JSON_PAYLOAD) payloads.push(text);
    else push(plain, key, inferValue(text));
  }

  let out: Record<string, unknown> = {};
  for (const [key, values] of plain) out[key] = one(values);
  for (const payload of payloads) {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new ApiError(400, "");
    }
    // Go's json.Unmarshal of null into the body map resets it
    if (data === null) {
      out = {};
      continue;
    }
    if (typeof data !== "object" || Array.isArray(data))
      throw new ApiError(400, "");
    Object.assign(out, data);
  }
  for (const [key, list] of files) {
    const prev = out[key];
    out[key] =
      prev === undefined
        ? one(list)
        : [...(Array.isArray(prev) ? prev : [prev]), ...list];
  }
  return out;
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
