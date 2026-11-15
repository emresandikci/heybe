// Reads at most `limit` bytes like Go's io.LimitReader (the rest is dropped).
export async function readCapped(
  res: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  while (reader && size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const part = value.subarray(0, limit - size);
    chunks.push(part);
    size += part.length;
  }
  if (size >= limit) await reader?.cancel().catch(() => {});
  return new Uint8Array(Buffer.concat(chunks));
}

export const readText = async (res: Response, limit: number) =>
  new TextDecoder().decode(await readCapped(res, limit));

export const decodeStrict = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const readJson = async (res: Response, limit: number) =>
  parseJson(decodeStrict(await readCapped(res, limit)));

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const INTEGER = /^-?\d+$/;
const MAX_DEPTH = 10000;

// A number written with a fraction or exponent: Go decodes it into a float64 field
// but never into an int64 one, so the form is kept for int().
export class Decimal {
  constructor(readonly value: number) {}
}

const isHex = (c: string | undefined) =>
  c !== undefined && /[0-9a-fA-F]/.test(c);

// Go encoding/json/v2 (used by PB's tools/auth): duplicate object names and invalid
// UTF-16 escapes are errors, an integer beyond 2^53 stays exact (as a bigint).
// Errors never carry the document's content.
export function parseJson(text: string): unknown {
  let i = 0;
  const fail = (reason = "invalid JSON"): never => {
    throw new SyntaxError(`${reason} at offset ${i}`);
  };
  const skip = () => {
    while (WS.has(text[i]!)) i++;
  };
  const hex4 = () => {
    if (![1, 2, 3, 4].every((n) => isHex(text[i + n]))) fail();
    const code = Number.parseInt(text.slice(i + 1, i + 5), 16);
    i += 4;
    return code;
  };
  const string = (): string => {
    if (text[i] !== '"') fail();
    const start = i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c < " ") fail();
      if (c === '"') break;
      if (c !== "\\") {
        i++;
        continue;
      }
      const e = text[++i];
      if (e === "u") {
        const code = hex4();
        if (code >= 0xdc00 && code <= 0xdfff) fail("invalid surrogate");
        if (code >= 0xd800 && code <= 0xdbff) {
          if (text[i + 1] !== "\\" || text[i + 2] !== "u")
            fail("invalid surrogate");
          i += 2;
          const low = hex4();
          if (low < 0xdc00 || low > 0xdfff) fail("invalid surrogate");
        }
      } else if (e === undefined || !'"\\/bfnrt'.includes(e)) fail();
      i++;
    }
    return JSON.parse(text.slice(start, ++i));
  };
  const literal = (word: string, value: unknown) => {
    if (!text.startsWith(word, i)) return fail();
    i += word.length;
    return value;
  };
  const value = (depth: number): unknown => {
    skip();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth >= MAX_DEPTH) fail("exceeded max depth");
      i++;
      skip();
      const close = c === "{" ? "}" : "]";
      const obj: Record<string, unknown> = {};
      const list: unknown[] = [];
      if (text[i] === close) return (i++, c === "{" ? obj : list);
      for (;;) {
        if (c === "{") {
          skip();
          const key = string();
          if (Object.hasOwn(obj, key)) fail("duplicate object member name");
          skip();
          if (text[i++] !== ":") fail();
          Object.defineProperty(obj, key, {
            value: value(depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        } else list.push(value(depth + 1));
        skip();
        const sep = text[i++];
        if (sep === close) return c === "{" ? obj : list;
        if (sep !== ",") fail();
      }
    }
    if (c === '"') return string();
    if (c === "t") return literal("true", true);
    if (c === "f") return literal("false", false);
    if (c === "n") return literal("null", null);
    NUMBER.lastIndex = i;
    const token = NUMBER.exec(text)?.[0];
    if (token === undefined) return fail();
    i += token.length;
    const n = Number(token);
    if (!INTEGER.test(token)) return new Decimal(n);
    return Number.isSafeInteger(n) ? n : BigInt(token);
  };
  const result = value(0);
  skip();
  if (i < text.length) fail();
  return result;
}
