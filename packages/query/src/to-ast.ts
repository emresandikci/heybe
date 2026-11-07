import type { Expr, Op, Operand } from "./ast";
import type { Where } from "./types";

export const MACROS: ReadonlySet<string> = new Set([
  "@now",
  "@second",
  "@minute",
  "@hour",
  "@weekday",
  "@day",
  "@month",
  "@year",
  "@yesterday",
  "@tomorrow",
  "@todayStart",
  "@todayEnd",
  "@monthStart",
  "@monthEnd",
  "@yearStart",
  "@yearEnd",
]);

const OPERATORS: [string, Op][] = [
  ["eq", "="],
  ["neq", "!="],
  ["gt", ">"],
  ["gte", ">="],
  ["lt", "<"],
  ["lte", "<="],
  ["like", "~"],
  ["notLike", "!~"],
  ["anyEq", "?="],
  ["anyNeq", "?!="],
  ["anyGt", "?>"],
  ["anyGte", "?>="],
  ["anyLt", "?<"],
  ["anyLte", "?<="],
  ["anyLike", "?~"],
  ["anyNotLike", "?!~"],
];

const OPERATOR_KEYS = new Set([
  ...OPERATORS.map(([key]) => key),
  "insensitive",
  "length",
  "each",
  "empty",
]);

type Plain = Record<string, unknown>;

const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

const isSkipped = (value: unknown) =>
  !(
    (typeof value === "string" && value !== "") ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    (value instanceof Date && !Number.isNaN(value.getTime()))
  );

const field = (path: string): Operand => ({ kind: "field", path });

function toOperand(value: unknown, lower: boolean): Operand {
  if (value instanceof Date) {
    return {
      kind: "value",
      value: value.toISOString().replace("T", " "),
    };
  }
  if (typeof value === "string") {
    if (MACROS.has(value)) return { kind: "macro", name: value };
    return { kind: "value", value: lower ? value.toLowerCase() : value };
  }
  return { kind: "value", value: value as number | boolean };
}

function operatorExprs(path: string, ops: Plain, insensitive: boolean): Expr[] {
  const lower = insensitive || ops.insensitive === true;
  const exprs: Expr[] = [];

  for (const [key, op] of OPERATORS) {
    const value = ops[key];
    if (isSkipped(value)) continue;
    exprs.push({
      kind: "cmp",
      op,
      left: field(lower ? `${path}:lower` : path),
      right: toOperand(value, lower),
    });
  }

  if (typeof ops.empty === "boolean") {
    exprs.push({
      kind: "cmp",
      op: ops.empty ? "=" : "!=",
      left: field(path),
      right: { kind: "value", value: "" },
    });
  }

  for (const modifier of ["length", "each"] as const) {
    if (isPlain(ops[modifier])) {
      exprs.push(...operatorExprs(`${path}:${modifier}`, ops[modifier], lower));
    }
  }

  return exprs;
}

function group(kind: "and" | "or", items: Expr[]): Expr | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!;
  return {
    kind,
    items: items.flatMap((item) => (item.kind === kind ? item.items : [item])),
  };
}

function whereExprs(where: Plain, prefix: string): Expr[] {
  const exprs: Expr[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (key === "AND" || key === "OR") {
      if (!Array.isArray(value)) continue;
      const items = value.flatMap((child) => {
        const node = group("and", whereExprs(child as Plain, prefix));
        return node ? [node] : [];
      });
      const node = group(key === "AND" ? "and" : "or", items);
      if (node) exprs.push(node);
      continue;
    }

    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlain(value)) {
      const isOperatorObject = Object.keys(value).some((k) =>
        OPERATOR_KEYS.has(k),
      );
      exprs.push(
        ...(isOperatorObject
          ? operatorExprs(path, value, false)
          : whereExprs(value, path)),
      );
    } else if (!isSkipped(value)) {
      exprs.push({
        kind: "cmp",
        op: "=",
        left: field(path),
        right: toOperand(value, false),
      });
    }
  }

  return exprs;
}

export function toAst<T = Record<string, unknown>>(
  where: Where<NoInfer<T>>,
): Expr | null {
  return group("and", whereExprs(where as Plain, ""));
}
