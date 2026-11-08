import type { Expr, Operand } from "./ast";

const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
};

// Only the escapes the PocketBase filter scanner (fexpr) decodes.
const quote = (value: string) =>
  `"${value.replace(/[\\"\n\t\r]/g, (ch) => ESCAPES[ch]!)}"`;

function operand(node: Operand): string {
  switch (node.kind) {
    case "field":
      return node.path;
    case "macro":
      return node.name;
    case "call":
      return `${node.name}(${node.args.map(operand).join(",")})`;
    case "value":
      return typeof node.value === "string"
        ? quote(node.value)
        : String(node.value);
  }
}

function render(expr: Expr): string {
  if (expr.kind === "cmp") {
    return `${operand(expr.left)}${expr.op}${operand(expr.right)}`;
  }
  const separator = expr.kind === "and" ? " && " : " || ";
  const parts = expr.items.flatMap((item) => {
    const text = render(item);
    if (text === "") return [];
    const nested = item.kind !== "cmp" && item.kind !== expr.kind;
    return [nested ? `(${text})` : text];
  });
  return parts.join(separator);
}

export function toFilter(expr: Expr | null): string {
  return expr ? render(expr) : "";
}
