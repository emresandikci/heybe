const EXT_INVALID = /[^\w.*\-+=#]+/g;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomPart(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

function extractExtension(name: string): string {
  const primary = name.lastIndexOf(".");
  if (primary === -1) return "";
  const secondary = name.lastIndexOf(".", primary - 1);
  return name.slice(secondary >= 0 && primary > 0 ? secondary : primary);
}

function trimDots(s: string): string {
  return s.replace(/^\.+|\.+$/g, "");
}

function snakecase(s: string): string {
  const words = s.split(/[^0-9A-Za-z]+/).filter((w) => w !== "");
  return words
    .map((word) => word.replace(/(?<=[^A-Z])(?=[A-Z])/g, "_"))
    .join("_")
    .toLowerCase();
}

// The last `max` UTF-8 bytes, without a partial code point (Go cuts the bytes, then the regexes drop
// the broken rune).
function lastBytes(s: string, max: number): string {
  const bytes = Buffer.from(s);
  if (bytes.length <= max) return s;
  let start = bytes.length - max;
  while ((bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

// `detectedExt` (with the leading dot) is used when the name has no usable extension.
export function normalizeFilename(original: string, detectedExt = ""): string {
  const name = lastBytes(original, 300);

  const ext = extractExtension(name);
  let cleanExt = `.${trimDots(ext.replace(EXT_INVALID, ""))}`;
  if (cleanExt === ".") cleanExt = detectedExt;
  if (cleanExt.length > 20) cleanExt = `.${trimDots(cleanExt.slice(-20))}`;

  const base = name.endsWith(ext)
    ? name.slice(0, name.length - ext.length)
    : name;
  let cleanName = snakecase(trimDots(base));
  if (cleanName.length < 3) cleanName += randomPart();
  else if (cleanName.length > 100) cleanName = cleanName.slice(0, 100);

  return `${cleanName}_${randomPart()}${cleanExt}`;
}
