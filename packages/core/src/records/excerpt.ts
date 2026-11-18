// Plain-text excerpt of an HTML string, like the PB `:excerpt(max, withEllipsis)` fields modifier.
// A small tag scanner stands in for golang.org/x/net/html; it only needs text nodes and element boundaries.

const EXCLUDE = new Set([
  "head",
  "style",
  "script",
  "iframe",
  "embed",
  "applet",
  "object",
  "svg",
  "img",
  "picture",
  "dialog",
  "template",
  "button",
  "form",
  "textarea",
  "input",
  "select",
  "option",
  // the HTML parser moves a leading <title> into <head>
  "title",
]);

const INLINE = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdo",
  "big",
  "br",
  "button",
  "cite",
  "code",
  "em",
  "i",
  "label",
  "q",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "time",
]);

const RAW_TEXT = new Set(["script", "style", "textarea", "title", "iframe"]);

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole, ref: string) => {
      if (ref[0] !== "#") return ENTITIES[ref] ?? whole;
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : "�";
    },
  );
}

const byteLength = (s: string) => Buffer.byteLength(s);

interface Open {
  name: string;
  block: boolean;
  skip: boolean;
}

const TAG = /<(\/?)([a-zA-Z][^\s/>]*)(?:[^>"']|"[^"]*"|'[^']*')*>?/y;

// Linear in the input: no whole-string copies per tag, skip state and open names are counted.
export function excerpt(html: string, max: number, withEllipsis: boolean) {
  let out = "";
  let outBytes = 0;
  let prevSpace = false;
  const stack: Open[] = [];
  let skipped = 0;
  const openNames = new Map<string, number>();
  const write = (t: string) => {
    out += t;
    outBytes += byteLength(t);
  };
  const space = () => {
    if (!prevSpace) {
      write(" ");
      prevSpace = true;
    }
  };
  const push = (o: Open) => {
    stack.push(o);
    if (o.skip) skipped++;
    openNames.set(o.name, (openNames.get(o.name) ?? 0) + 1);
  };

  const text = (raw: string) => {
    if (skipped > 0) return;
    let t = decodeEntities(raw).replace(/[\t\n\f\r ]+/g, " ");
    if (prevSpace) t = t.replace(/^ +/, "");
    if (t === "") return;
    prevSpace = t.endsWith(" ");
    write(t);
  };

  const open = (name: string) => {
    if (skipped > 0 || EXCLUDE.has(name)) {
      if (!VOID.has(name)) push({ name, block: false, skip: true });
      return;
    }
    const block = !INLINE.has(name);
    if (block) space();
    if (VOID.has(name)) {
      if (block) space();
      return;
    }
    // PB stops descending into elements once the collected text is long enough
    push({ name, block, skip: outBytes > max + 2 });
  };

  const close = (name: string) => {
    if (!openNames.get(name)) return;
    for (;;) {
      const s = stack.pop()!;
      if (s.skip) skipped--;
      openNames.set(s.name, openNames.get(s.name)! - 1);
      if (s.block && skipped === 0) space();
      if (s.name === name) return;
    }
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text(html.slice(i));
      break;
    }
    if (lt > i) text(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    TAG.lastIndex = i;
    const tag = TAG.exec(html);
    if (!tag) {
      text("<");
      i++;
      continue;
    }
    i += tag[0].length;
    const name = tag[2]!.toLowerCase();
    if (tag[1]) {
      close(name);
      continue;
    }
    open(name);
    if (RAW_TEXT.has(name)) {
      const endTag = new RegExp(`</${name}`, "gi");
      endTag.lastIndex = i;
      const end = endTag.exec(html)?.index ?? html.length;
      text(html.slice(i, end));
      i = end;
    }
  }

  let result = out.trim();
  if (byteLength(result) > max) {
    const runes = Array.from(result);
    if (runes.length > max) {
      result = runes.slice(0, max).join("").trim();
      if (withEllipsis) result += "...";
    }
  }
  return result;
}
