const isWs = (b: number) =>
  b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();
const NONE = new Uint8Array(0);

const HTML_SIGNATURES = [
  "<!DOCTYPE HTML",
  "<HTML",
  "<HEAD",
  "<SCRIPT",
  "<IFRAME",
  "<H1",
  "<DIV",
  "<FONT",
  "<TABLE",
  "<A",
  "<STYLE",
  "<TITLE",
  "<B",
  "<BODY",
  "<BR",
  "<P",
  "<!--",
];

class Scan {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  get left() {
    return this.b.length - this.i;
  }
  peek() {
    return this.b[this.i] ?? 0;
  }
  pop() {
    const v = this.peek();
    if (this.i < this.b.length) this.i++;
    return v;
  }
  advance(n: number) {
    this.i = Math.min(this.i + n, this.b.length);
  }
  popUntil(...stops: number[]) {
    const start = this.i;
    while (this.i < this.b.length && !stops.includes(this.b[this.i]!)) this.i++;
    return this.b.subarray(start, this.i);
  }
  skipWs() {
    while (isWs(this.peek())) this.advance(1);
  }
  // An upper case letter in the pattern matches both cases, like mimetype's scan.IgnoreCase.
  matches(pattern: string, ignoreCase: boolean) {
    if (this.left < pattern.length) return false;
    for (let k = 0; k < pattern.length; k++) {
      const p = pattern.charCodeAt(k);
      let b = this.b[this.i + k]!;
      if (ignoreCase && p >= 65 && p <= 90 && b >= 97 && b <= 122) b -= 32;
      if (b !== p) return false;
    }
    return true;
  }
}

// Port of mimetype magic.markup: the signature must be followed by whitespace or ">".
function markup(head: Uint8Array, sigs: string[]): boolean {
  const s = new Scan(head);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) s.advance(3);
  s.skipWs();
  if (s.left === 0) return false;
  return sigs.some((sig) => {
    if (s.left < sig.length + 1) return false;
    for (let k = 0; k < sig.length; k++) {
      const p = sig.charCodeAt(k);
      let b = s.b[s.i + k]!;
      if (p >= 65 && p <= 90) b &= 0xdf;
      if (b !== p) return false;
    }
    const next = s.b[s.i + sig.length]!;
    return isWs(next) || next === 62;
  });
}

export const isHtml = (head: Uint8Array) => markup(head, HTML_SIGNATURES);
export const isXml = (head: Uint8Array) => markup(head, ["<?XML"]);

export function isXhtml(head: Uint8Array): boolean {
  const text = latin1.decode(head.subarray(0, 1024));
  return (
    /<!DOCTYPE[\t\n\f\r ]+HTML/i.test(text) ||
    /<HTML[\t\n\f\r ]+XMLNS=/i.test(text)
  );
}

interface Attribute {
  name: Uint8Array;
  value: Uint8Array;
  more: boolean;
}

function attributeValue(s: Scan): { value: Uint8Array; more: boolean } {
  s.skipWs();
  const start = s.i;
  let end = 1;
  const first = s.pop();
  if (first === 0) return { value: NONE, more: false };
  if (first === 34 || first === 39) {
    const value = s.popUntil(first);
    if (s.pop() !== first) return { value: NONE, more: false };
    return { value, more: s.peek() !== 0 && s.peek() !== 62 };
  }
  if (first === 62) return { value: NONE, more: false };
  for (;;) {
    const c = s.pop();
    if (c === 0) return { value: NONE, more: false };
    if (isWs(c)) return { value: s.b.subarray(start, start + end), more: true };
    if (c === 62)
      return { value: s.b.subarray(start, start + end), more: false };
    end++;
  }
}

function attribute(s: Scan): Attribute {
  while (isWs(s.peek()) || s.peek() === 47) s.advance(1);
  if (s.peek() === 62) return { name: NONE, value: NONE, more: false };
  const start = s.i;
  let end = 0;
  for (;;) {
    const c = s.pop();
    const name = () => s.b.subarray(start, start + end);
    if (c === 0) return { name: NONE, value: NONE, more: false };
    if (c === 61 && end > 0) return { name: name(), ...attributeValue(s) };
    if (isWs(c)) {
      s.skipWs();
      if (s.peek() !== 61) return { name: name(), value: NONE, more: true };
      s.advance(1);
      return { name: name(), ...attributeValue(s) };
    }
    if (c === 47 || c === 62) return { name: name(), value: NONE, more: false };
    end++;
  }
}

function skipComment(s: Scan): boolean {
  if (!s.matches("<!--", false)) return false;
  const close = indexOf(s.b, "-->", s.i + 2);
  if (close === -1) return false;
  s.i = close + 3;
  return true;
}

function indexOf(b: Uint8Array, text: string, from: number): number {
  return Buffer.from(b.buffer, b.byteOffset, b.length).indexOf(text, from);
}

function charsetFromMeta(content: Uint8Array): string {
  const s = new Scan(content);
  for (;;) {
    const found = indexOf(content, "charset", s.i);
    if (found === -1) return "";
    s.i = found + 7;
    s.skipWs();
    if (s.pop() !== 61) continue;
    s.skipWs();
    const quote = s.peek();
    if (quote === 0) return "";
    if (quote === 34 || quote === 39) {
      s.advance(1);
      return latin1.decode(s.popUntil(quote)).trim();
    }
    return latin1.decode(s.popUntil(59, 9, 10, 12, 13, 32)).trim();
  }
}

// Port of mimetype charset.fromHTML: the charset declared by a <meta> tag before <body>.
export function charsetFromHtml(head: Uint8Array): string {
  const s = new Scan(head);
  for (;;) {
    if (skipComment(s)) continue;
    if (s.left <= 5) return "";
    if (s.matches("<BODY", true)) return "";
    if (!s.matches("<META", true)) {
      s.advance(1);
      continue;
    }
    s.advance(5);
    const c = s.pop();
    if (c === 0 || (!isWs(c) && c !== 47)) return "";

    const seen = new Set<string>();
    let gotPragma = false;
    let need: "unknown" | "pragma" | "none" = "unknown";
    let charset = "";
    let more = true;
    while (more) {
      const attr = attribute(s);
      more = attr.more;
      const name = utf8.decode(attr.name).toLowerCase();
      if (seen.has(name)) continue;
      if (name === "" && attr.value.length === 0) {
        if (need === "unknown") continue;
        if (need === "pragma" && !gotPragma) continue;
      }
      seen.add(name);
      if (name === "http-equiv") {
        if (new Scan(attr.value).matches("CONTENT-TYPE", true))
          gotPragma = true;
      } else if (name === "content") {
        charset = charsetFromMeta(attr.value);
        if (charset !== "") need = "pragma";
      } else if (name === "charset") {
        charset = utf8.decode(attr.value);
        need = "none";
      }
    }
    if (need === "unknown" || (need === "pragma" && !gotPragma)) continue;
    return charset;
  }
}

// Port of mimetype charset.fromXML: the encoding attribute of the <?xml declaration.
export function charsetFromXml(head: Uint8Array): string {
  const s = new Scan(head);
  for (;;) {
    s.skipWs();
    if (s.left <= 5) return "";
    const found = indexOf(head, "<?xml", s.i);
    if (found === -1) return "";
    s.i = found + 5;
    let more = true;
    while (more) {
      const attr = attribute(s);
      more = attr.more;
      if (
        new Scan(attr.name).matches("encoding", false) &&
        attr.value.length > 0
      )
        return utf8.decode(attr.value);
    }
  }
}
