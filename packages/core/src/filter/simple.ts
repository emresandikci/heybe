import type { Expr, Operand } from "@heybe/query";
import { call, wrapLike } from "./compile";
import { macroValue } from "./macros";
import { FilterError, parseFilter, parseSort } from "./parse";

const LITERALS: Record<string, string> = {
  null: "NULL",
  true: "1",
  false: "0",
};

export interface SimpleFields {
  columns: string[];
  json?: { column: string; pattern: RegExp };
}

export interface SimpleQuery {
  where: string;
  orderBy: string;
  params: unknown[];
}

// PB SimpleFieldResolver: the path after the JSON column becomes a JSON_EXTRACT path without unsafe characters.
function jsonExtract(column: string, path: string): string {
  const steps = path
    .split(".")
    .slice(1)
    .map((part) => {
      const safe = part.replace(/[^\w*@#-]/g, "");
      return /^\d+$/.test(part) ? `[${safe}]` : `.${safe}`;
    });
  return `JSON_EXTRACT(\`${column}\`, '$${steps.join("")}')`;
}

export function compileSimpleQuery(
  filter: string,
  sort: string,
  now: () => Date,
  fields: SimpleFields,
): SimpleQuery {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `?${params.length}`;
  };

  const resolve = (path: string): string | null => {
    if (fields.columns.includes(path)) return `\`${path}\``;
    if (fields.json?.pattern.test(path))
      return jsonExtract(fields.json.column, path);
    return null;
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
        const resolved = resolve(o.path);
        if (resolved) return resolved;
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
    const jsonLeft =
      e.left.kind === "field" &&
      !fields.columns.includes(e.left.path) &&
      fields.json?.pattern.test(e.left.path) === true;
    if (jsonLeft && e.right.kind === "value" && e.right.value === "") {
      if (sign === "=") return `(${left} = '' OR ${left} IS NULL)`;
      if (sign === "!=") return `(${left} != '' AND ${left} IS NOT NULL)`;
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
      else {
        const resolved = resolve(field);
        if (!resolved) throw new FilterError(`invalid sort field "${field}"`);
        order.push(`${resolved} ${dir}`);
      }
    }
  }
  return { where, orderBy: order.join(", "), params };
}
