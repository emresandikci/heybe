import { randomInt } from "node:crypto";

type Node =
  | { kind: "lit"; text: string }
  | { kind: "set"; pairs: [string, string][] }
  | { kind: "cat" | "alt"; items: Node[] }
  | { kind: "rep"; node: Node; min: number; max: number };

const MAX_REPEAT = 6;
const ANY: [string, string][] = [
  ["A", "Z"],
  ["a", "z"],
  ["0", "9"],
];
const DIGIT: [string, string][] = [["0", "9"]];
const WORD: [string, string][] = [...ANY, ["_", "_"]];

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw new Error("unexpected ) in pattern");
    return node;
  }

  private alt(): Node {
    const items = [this.cat()];
    while (this.src[this.i] === "|") {
      this.i++;
      items.push(this.cat());
    }
    return items.length === 1 ? items[0]! : { kind: "alt", items };
  }

  private cat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && !"|)".includes(this.src[this.i]!)) {
      const atom = this.atom();
      if (atom) items.push(this.quantify(atom));
    }
    return { kind: "cat", items };
  }

  private atom(): Node | null {
    const c = this.src[this.i++]!;
    if (c === "^" || c === "$") return null;
    if (c === ".") return { kind: "set", pairs: ANY };
    if (c === "\\") return this.escape(this.src[this.i++] ?? "\\");
    if (c === "[") return this.charClass();
    if (c === "(") {
      if (this.src.startsWith("?:", this.i)) this.i += 2;
      const node = this.alt();
      if (this.src[this.i++] !== ")") throw new Error("missing ) in pattern");
      return node;
    }
    return { kind: "lit", text: c };
  }

  private escape(
    c: string,
  ):
    { kind: "lit"; text: string } | { kind: "set"; pairs: [string, string][] } {
    if (c === "d") return { kind: "set", pairs: DIGIT };
    if (c === "w") return { kind: "set", pairs: WORD };
    return { kind: "lit", text: c };
  }

  private charClass(): Node {
    if (this.src[this.i] === "^") throw new Error("negated class in pattern");
    const pairs: [string, string][] = [];
    while (this.src[this.i] !== "]") {
      if (this.i >= this.src.length) throw new Error("missing ] in pattern");
      const c = this.src[this.i++]!;
      if (c === "\\") {
        const e = this.escape(this.src[this.i++] ?? "\\");
        if (e.kind === "set") pairs.push(...e.pairs);
        else pairs.push([e.text, e.text]);
        continue;
      }
      let end = c;
      if (this.src[this.i] === "-" && this.src[this.i + 1] !== "]") {
        end = this.src[this.i + 1]!;
        this.i += 2;
      }
      pairs.push([c, end]);
    }
    this.i++;
    return { kind: "set", pairs };
  }

  private quantify(node: Node): Node {
    const c = this.src[this.i];
    let min: number;
    let max: number;
    if (c === "?") [min, max] = [0, 1];
    else if (c === "*") [min, max] = [0, -1];
    else if (c === "+") [min, max] = [1, -1];
    else if (c === "{") {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) return node;
      min = Number(m[1]);
      max = m[2] ? (m[3] ? Number(m[3]) : -1) : min;
      this.i += m[0].length - 1;
    } else return node;
    this.i++;
    if (this.src[this.i] === "?") this.i++;
    return { kind: "rep", node, min, max };
  }
}

function write(node: Node): string {
  switch (node.kind) {
    case "lit":
      return node.text;
    case "set": {
      const sizes = node.pairs.map(
        ([a, b]) => b.codePointAt(0)! - a.codePointAt(0)! + 1,
      );
      let n = randomInt(sizes.reduce((x, y) => x + y, 0));
      for (const [i, size] of sizes.entries()) {
        if (n < size)
          return String.fromCodePoint(node.pairs[i]![0].codePointAt(0)! + n);
        n -= size;
      }
      return "";
    }
    case "cat":
      return node.items.map(write).join("");
    case "alt":
      return write(node.items[randomInt(node.items.length)]!);
    case "rep": {
      const max = node.max < 0 ? MAX_REPEAT : Math.max(node.max, node.min);
      const count =
        node.min + (max === node.min ? 0 : randomInt(max - node.min));
      return Array.from({ length: count }, () => write(node.node)).join("");
    }
  }
}

export function randomByPattern(pattern: string): string {
  return write(new Parser(pattern).parse());
}
