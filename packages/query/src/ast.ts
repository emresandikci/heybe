export type Op =
  | "="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "~"
  | "!~"
  | "?="
  | "?!="
  | "?>"
  | "?>="
  | "?<"
  | "?<="
  | "?~"
  | "?!~";

export type Operand =
  | { kind: "field"; path: string }
  | { kind: "value"; value: string | number | boolean | null }
  | { kind: "macro"; name: string }
  | { kind: "call"; name: string; args: Operand[] };

export type Expr =
  | { kind: "and" | "or"; items: Expr[] }
  | { kind: "cmp"; op: Op; left: Operand; right: Operand };
