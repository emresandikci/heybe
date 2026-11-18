import { parse } from "parse5";

interface TreeNode {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: TreeNode[];
}

const TAGS_TO_SKIP = new Set([
  "style",
  "script",
  "iframe",
  "applet",
  "object",
  "svg",
  "img",
  "button",
  "form",
  "textarea",
  "input",
  "select",
  "option",
  "template",
]);

const INLINE_TAGS = new Set([
  "a",
  "span",
  "small",
  "strike",
  "strong",
  "sub",
  "sup",
  "em",
  "b",
  "u",
  "i",
]);

const isText = (n: TreeNode) => n.nodeName === "#text";
const isElement = (n: TreeNode) => !n.nodeName.startsWith("#");

export function html2text(html: string): string {
  const doc = parse(html) as unknown as TreeNode;
  const main = { s: "" };
  let canAddNewLine = false;

  const visit = (n: TreeNode, active: { s: string }) => {
    const isLink = isElement(n) && n.nodeName === "a";
    if (isLink) active = { s: "" };

    if (isText(n)) {
      let txt = n.value!.replace(/[\t\n\f\r ]+/g, " ");
      if (!canAddNewLine) txt = txt.replace(/^ +/, "");
      if (txt !== "") {
        active.s += txt;
        canAddNewLine = true;
      }
    } else if (isElement(n)) {
      if (n.nodeName === "br") {
        active.s += "\r\n";
        canAddNewLine = false;
      } else if (canAddNewLine && !INLINE_TAGS.has(n.nodeName)) {
        active.s += "\r\n";
        canAddNewLine = false;
      }
      if (n.nodeName === "li") active.s += "- ";
    }

    for (const c of n.childNodes ?? [])
      if (!isElement(c) || !TAGS_TO_SKIP.has(c.nodeName)) visit(c, active);

    if (isLink) {
      const label = active.s.trim() || "LINK";
      main.s += `[${label}]`;
      const href = n.attrs?.find((a) => a.name === "href");
      if (href && href.value !== "") main.s += `(${href.value})`;
      active.s = "";
    }
  };

  visit(doc, main);
  return main.s.trim();
}
