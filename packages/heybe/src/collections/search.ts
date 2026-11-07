import type { Expr, Operand } from "@heybe/query";
import { call, wrapLike } from "../filter/compile";
import { macroValue } from "../filter/macros";
import { FilterError, parseFilter, parseSort } from "../filter/parse";

const COLUMNS = ["id", "created", "updated", "name", "system", "type"];
const LITERALS: Record<string, string> = {
  null: "NULL",
  true: "1",
  false: "0",
};

export interface CollectionsQuery {
  where: string;
  orderBy: string;
  params: unknown[];
}

export function compileCollectionsQuery(
  filter: string,
  sort: string,
  now: () => Date,
): CollectionsQuery {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `?${params.length}`;
  };

  const operand = (o: Operand): string => {
    switch (o.kind) {
      case "value":
        if (o.value === null) return "NULL";
        if (typeof o.value === "boolean") return o.value ? "1" : "0";
        return bind(o.value);
      case "macro":
        return bind(macroValue(o.name, now));
      case "call":
        return call(o, (a) => ({
          id: operand(a),
          params: [],
          nullFallback: "auto",
        })).id;
      case "field": {
        if (COLUMNS.includes(o.path)) return `\`${o.path}\``;
        const literal = LITERALS[o.path.toLowerCase()];
        if (literal) return literal;
        throw new FilterError(`failed to resolve field ${o.path}`);
      }
    }
  };

  const build = (e: Expr): string => {
    if (e.kind !== "cmp")
      return `(${e.items.map(build).join(e.kind === "and" ? " AND " : " OR ")})`;
    const sign = e.op.replace("?", "");
    const left = operand(e.left);
    if (sign === "~" || sign === "!~") {
      const like = sign === "~" ? "LIKE" : "NOT LIKE";
      if (e.right.kind === "value" && e.right.value !== null) {
        const pattern = bind(wrapLike(e.right.value));
        return `${left} ${like} ${pattern} ESCAPE '\\'`;
      }
      return `${left} ${like} ('%' || ${operand(e.right)} || '%') ESCAPE '\\'`;
    }
    const right = operand(e.right);
    if (sign === "=") return `${left} IS ${right}`;
    if (sign === "!=") return `${left} IS NOT ${right}`;
    return `${left} ${sign} ${right}`;
  };

  const expr = parseFilter(filter);
  const where = expr ? build(expr) : "1=1";

  const order: string[] = [];
  if (sort !== "") {
    if (sort.split(",").some((part) => part.trim() === ""))
      throw new FilterError("invalid sort");
    for (const { field, dir } of parseSort(sort)) {
      if (field === "@random") order.push("RANDOM()");
      else if (field === "@rowid") order.push(`_rowid_ ${dir}`);
      else if (COLUMNS.includes(field)) order.push(`\`${field}\` ${dir}`);
      else throw new FilterError(`invalid sort field "${field}"`);
    }
  }
  return { where, orderBy: order.join(", "), params };
}
