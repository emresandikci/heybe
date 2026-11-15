import { fileTypeFromBuffer } from "file-type";
import {
  charsetFromHtml,
  charsetFromXml,
  isHtml,
  isXhtml,
  isXml,
} from "./markup";

const HEAD_SIZE = 4096;
const SVG_NS =
  /^<svg\b[^>]*?\sxmlns\s*=\s*(["'])http:\/\/www\.w3\.org\/2000\/svg\1/;
const XML_DECL = /^\s*<\?xml\b[^?>]*\bversion\s*=/;
const BOMS: [number[], string][] = [
  [[0xef, 0xbb, 0xbf], "utf-8"],
  [[0x00, 0x00, 0xfe, 0xff], "utf-32be"],
  [[0xff, 0xfe, 0x00, 0x00], "utf-32le"],
  [[0xfe, 0xff], "utf-16be"],
  [[0xff, 0xfe], "utf-16le"],
];

function isSvg(text: string): boolean {
  if (XML_DECL.test(text)) return text.slice(0, 4096).includes("<svg");
  let rest = text.trimStart();
  for (
    let m = /^<!--[\s\S]*?-->\s*/.exec(rest);
    m;
    m = /^<!--[\s\S]*?-->\s*/.exec(rest)
  ) {
    rest = rest.slice(m[0].length);
  }
  return SVG_NS.test(rest);
}

function hasBinaryByte(head: Uint8Array): boolean {
  return head.some(
    (b) =>
      b <= 0x08 ||
      b === 0x0b ||
      (b >= 0x0e && b <= 0x1a) ||
      (b >= 0x1c && b <= 0x1f),
  );
}

function isLatinText(head: Uint8Array): boolean {
  return head.every(
    (b) =>
      b === 0x85 ||
      (b >= 0x20 && b < 0x7f) ||
      b >= 0xa0 ||
      [7, 8, 9, 10, 11, 12, 13, 27].includes(b),
  );
}

function bomOf(head: Uint8Array): string {
  const found = BOMS.find(([bom]) => bom.every((b, i) => head[i] === b));
  return found ? found[1] : "";
}

function charsetOf(head: Uint8Array): string {
  if (head.length === 0) return "";
  const bom = bomOf(head);
  if (bom) return bom;
  let end = head.length;
  for (let i = head.length - 1; i >= 0 && i > head.length - 4; i--) {
    const b = head[i] as number;
    if (b < 0x80) break;
    if ((b & 0xc0) !== 0x80) {
      end = i;
      break;
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, end));
    return "utf-8";
  } catch {
    if (!isLatinText(head)) return "";
    return head.includes(0x85) ? "windows-1252" : "iso-8859-1";
  }
}

type JsonStatus = "complete" | "prefix" | "invalid";

class Eof extends Error {}

function jsonStatus(s: string): JsonStatus {
  let i = 0;
  const ws = () => {
    while (i < s.length && " \t\n\r".includes(s[i] as string)) i++;
  };
  const peek = (): string => {
    ws();
    if (i >= s.length) throw new Eof();
    return s[i] as string;
  };
  const invalid = (): never => {
    throw new SyntaxError();
  };
  const literal = (word: string) => {
    const part = s.slice(i, i + word.length);
    if (part === word) i += word.length;
    else if (part.length < word.length && word.startsWith(part))
      throw new Eof();
    else invalid();
  };
  const string = () => {
    i++;
    for (;;) {
      if (i >= s.length) throw new Eof();
      const c = s[i] as string;
      if (c === '"') return void i++;
      if (c < " ") invalid();
      if (c === "\\") {
        if (i + 1 >= s.length) throw new Eof();
        const e = s[i + 1] as string;
        if (e === "u") {
          const hex = s.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]*$/.test(hex)) invalid();
          if (hex.length < 4) throw new Eof();
          i += 6;
        } else if ('"\\/bfnrt'.includes(e)) i += 2;
        else invalid();
      } else i++;
    }
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (m && i + m[0].length < s.length) return void (i += m[0].length);
    if (/^-?\d*(\.\d*)?([eE][+-]?\d*)?$/.test(s.slice(i))) throw new Eof();
    invalid();
  };
  const container = (close: string, item: () => void) => {
    i++;
    if (peek() === close) return void i++;
    for (;;) {
      item();
      const c = peek();
      i++;
      if (c === close) return;
      if (c !== ",") invalid();
    }
  };
  const value = (): void => {
    const c = peek();
    if (c === "{") {
      container("}", () => {
        if (peek() !== '"') invalid();
        string();
        if (peek() !== ":") invalid();
        i++;
        value();
      });
    } else if (c === "[") container("]", value);
    else if (c === '"') string();
    else if (c === "t") literal("true");
    else if (c === "f") literal("false");
    else if (c === "n") literal("null");
    else number();
  };

  try {
    value();
    ws();
    return i === s.length ? "complete" : "invalid";
  } catch (e) {
    if (e instanceof Eof) return "prefix";
    if (e instanceof SyntaxError) return "invalid";
    throw e;
  }
}

function isJson(text: string, truncated: boolean): boolean {
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return false;
  const status = jsonStatus(text);
  return status === "complete" || (truncated && status === "prefix");
}

const withCharset = (mime: string, charset: string) =>
  charset ? `${mime}; charset=${charset}` : mime;

// mimetype's xml children checked before xhtml, matched in the first 512 bytes after leading whitespace
const XML_SUBTYPES: [string, [string, string][]][] = [
  ["application/rss+xml", [["<rss", ""]]],
  ["application/atom+xml", [["<feed", 'xmlns="http://www.w3.org/2005/Atom"']]],
  [
    "application/vnd.google-earth.kml+xml",
    [
      ["<kml", 'xmlns="http://www.opengis.net/kml/2.2"'],
      ["<kml", 'xmlns="http://earth.google.com/kml/2.0"'],
      ["<kml", 'xmlns="http://earth.google.com/kml/2.1"'],
      ["<kml", 'xmlns="http://earth.google.com/kml/2.2"'],
    ],
  ],
];

function xmlSubtype(head: Uint8Array): string | undefined {
  let start = 0;
  while (start < head.length && [9, 10, 12, 13, 32].includes(head[start]!))
    start++;
  const raw = Buffer.from(head.subarray(start, start + 512));
  return XML_SUBTYPES.find(([, sigs]) =>
    sigs.some(([name, xmlns]) => {
      const at = raw.indexOf(name);
      return xmlns === "" ? at > 0 : at !== -1 && at < raw.indexOf(xmlns);
    }),
  )?.[0];
}

const htmlCharset = (head: Uint8Array) =>
  bomOf(head) || charsetFromHtml(head) || charsetOf(head);

export async function sniffMime(data: Blob | Uint8Array): Promise<string> {
  const head =
    data instanceof Blob
      ? new Uint8Array(await data.slice(0, HEAD_SIZE).arrayBuffer())
      : data.subarray(0, HEAD_SIZE);
  let decoded: string | undefined;
  const text = () => (decoded ??= new TextDecoder("utf-8").decode(head));

  const type = await fileTypeFromBuffer(head);
  if (type && type.mime !== "application/xml") return type.mime;
  if (Buffer.from(head).includes("<svg") && isSvg(text()))
    return "image/svg+xml";

  if (!bomOf(head) && hasBinaryByte(head)) return "application/octet-stream";
  if (isJson(text(), head.length >= HEAD_SIZE)) return "application/json";
  // mimetype looks for the charset in the first 1024 bytes only
  const start = head.subarray(0, 1024);
  if (isHtml(head)) return withCharset("text/html", htmlCharset(start));
  if (isXml(head))
    return (
      xmlSubtype(head) ??
      (isXhtml(head)
        ? "application/xhtml+xml"
        : withCharset("text/xml", charsetFromXml(start) || charsetOf(start)))
    );
  const charset = charsetOf(head);
  return charset ? `text/plain; charset=${charset}` : "text/plain";
}

// Extensions PB's mimetype library reports for the common sniffed types; others get none.
const EXTENSIONS: Record<string, string> = {
  "text/plain": ".txt",
  "application/json": ".json",
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/rss+xml": ".rss",
  "application/atom+xml": ".atom",
  "application/vnd.google-earth.kml+xml": ".kml",
};

export function mimeExtension(mime: string): string {
  return EXTENSIONS[mime.split(";")[0]!.trim()] ?? "";
}
