import type { Expr, Op, Operand } from "@heybe/query";
import { quote } from "../collections/ddl";
import type { Collection } from "../collections/model";
import type { CollectionStore } from "../collections/store";
import { macroValue } from "./macros";
import { FilterError, parseFilter } from "./parse";
import {
  type MultiMatch,
  type NullFallback,
  type Resolved,
  Resolver,
  col,
  joinSql,
  multiMatchSql,
  placeholder,
  plain,
} from "./resolve";

export interface RequestInfo {
  auth: Record<string, unknown> | null;
  authCollection: string | null;
  body: Record<string, unknown>;
  query: Record<string, string>;
  headers: Record<string, string>;
  method: string;
  context: string;
}

// `sql` and `joins` use numbered `?N` parameters into `params`. Use SELECT DISTINCT when `joins` is not empty.
export interface Compiled {
  sql: string;
  params: unknown[];
  joins: string[];
}

export interface CompileCtx {
  collection: Collection;
  store: CollectionStore;
  request: RequestInfo | null;
  now: () => Date;
}

type SortField = { field: string; dir: "ASC" | "DESC" };

const MAX_EXPRESSIONS = 200;

// Builds the WHERE, joins and ORDER BY of one query. Like PB's list endpoint, compile the API rule with
// `allowHidden` on, then set it to false before adding a non-superuser's filter and sort.
export class QueryCompiler {
  private readonly resolver: Resolver;
  private readonly where: string[] = [];
  private readonly order: string[] = [];

  constructor(private readonly ctx: CompileCtx) {
    this.resolver = new Resolver(ctx);
  }

  get allowHidden(): boolean {
    return this.resolver.allowHidden;
  }

  set allowHidden(value: boolean) {
    this.resolver.allowHidden = value;
  }

  filter(expr: Expr | null): this {
    if (expr) this.where.push(buildFilter(expr, this.resolver, this.ctx.now));
    return this;
  }

  sort(fields: SortField[]): this {
    for (const { field, dir } of fields) {
      if (field === "@random") this.order.push("RANDOM()");
      else if (field === "@rowid")
        this.order.push(`${col(this.ctx.collection.name, "_rowid_")} ${dir}`);
      else this.order.push(`${this.sortColumn(field)} ${dir}`);
    }
    return this;
  }

  build(): Compiled & { orderBy: string } {
    const r = this.resolver;
    const where = [...this.where];
    const joins = [...r.joins];

    // a joined collection is visible only through its list rule (see PB updateQueryWithCollectionListRule)
    if (!r.allowHidden) {
      for (const { collection, alias } of r.ruleJoins) {
        if (!collection.listRule) continue;
        const rule = r.ruleResolver(collection, alias);
        where.push(
          buildFilter(
            parseFilter(`id='' || (\n${collection.listRule}\n)`)!,
            rule,
            this.ctx.now,
          ),
        );
        joins.push(...rule.joins);
      }
    }

    const params: unknown[] = [];
    const numbers = new Map<string, string>();
    const bind = (sql: string) =>
      sql.replace(/\{:(p\d+)\}/g, (_, key: string) => {
        let n = numbers.get(key);
        if (!n) {
          const value = r.state.values.get(key);
          params.push(typeof value === "boolean" ? Number(value) : value);
          n = `?${params.length}`;
          // bun binds integral numbers as INTEGER; "+ 0.0" gives a REAL with no affinity, like a bound float64
          if (typeof value === "number" && !r.state.integers.has(key))
            n = `(${n} + 0.0)`;
          numbers.set(key, n);
        }
        return n;
      });

    return {
      joins: joins.map((j) => bind(joinSql(j))),
      sql: bind(
        where.length > 0 ? where.map((w) => `(${w})`).join(" AND ") : "1=1",
      ),
      orderBy: bind(this.order.join(", ")),
      params,
    };
  }

  private sortColumn(field: string): string {
    let result: Resolved;
    try {
      result = this.resolver.resolve(field);
    } catch (e) {
      if (e instanceof FilterError)
        throw new FilterError(`invalid sort field "${field}"`);
      throw e;
    }
    if (
      result.params.length > 0 ||
      result.id === "" ||
      result.id.toLowerCase() === "null"
    ) {
      throw new FilterError(`invalid sort field "${field}"`);
    }
    return result.id;
  }
}

export function compileFilter(expr: Expr | null, ctx: CompileCtx): Compiled {
  const { sql, params, joins } = new QueryCompiler(ctx).filter(expr).build();
  return { sql, params, joins };
}

export function compileSort(sort: SortField[], ctx: CompileCtx): string {
  const compiled = new QueryCompiler(ctx).sort(sort).build();
  if (compiled.joins.length > 0) {
    throw new FilterError(
      "sorting by a relation field needs the joins from QueryCompiler",
    );
  }
  return compiled.orderBy;
}

const countExpressions = (e: Expr): number =>
  e.kind === "cmp"
    ? 1
    : e.items.reduce((n, item) => n + countExpressions(item), 0);

function buildFilter(expr: Expr, r: Resolver, now: () => Date): string {
  if (countExpressions(expr) > MAX_EXPRESSIONS)
    throw new FilterError("max filter expressions limit reached");
  return buildExpr(expr, r, now);
}

function buildExpr(expr: Expr, r: Resolver, now: () => Date): string {
  if (expr.kind === "cmp") {
    const left = side("left", expr.left, r, now);
    const right = side("right", expr.right, r, now);
    return compare(r, left, expr.op, right);
  }
  return `(${expr.items.map((item) => buildExpr(item, r, now)).join(expr.kind === "and" ? " AND " : " OR ")})`;
}

function side(
  which: "left" | "right",
  o: Operand,
  r: Resolver,
  now: () => Date,
): Resolved {
  try {
    return operand(o, r, now);
  } catch (e) {
    if (!(e instanceof FilterError)) throw e;
    const literal =
      o.kind === "value"
        ? String(o.value)
        : o.kind === "field"
          ? o.path
          : o.name;
    throw new FilterError(
      `invalid ${which} operand ${JSON.stringify(literal)} - ${e.message}`,
    );
  }
}

const bound = (r: Resolver, value: unknown, integer = false): Resolved => {
  const key = r.param(value, integer);
  return { id: placeholder(key), params: [key], nullFallback: "auto" };
};

// identifiers that fall back to SQL literals when no such field exists
const LITERALS = new Map([
  ["null", "NULL"],
  ["true", "1"],
  ["false", "0"],
]);

function operand(o: Operand, r: Resolver, now: () => Date): Resolved {
  switch (o.kind) {
    case "value":
      if (o.value === null) return plain("NULL");
      if (typeof o.value === "boolean") return plain(o.value ? "1" : "0");
      return bound(r, o.value);
    case "macro":
      return bound(r, macroValue(o.name, now), true);
    case "call":
      return call(o, (a) => operand(a, r, now));
    case "field":
      return field(o.path, r, now);
  }
}

function field(path: string, r: Resolver, now: () => Date): Resolved {
  let result: Resolved;
  try {
    result = r.resolve(path);
  } catch (e) {
    const literal = LITERALS.get(path.toLowerCase());
    if (e instanceof FilterError && literal) return plain(literal);
    throw e;
  }
  if (result.changed) {
    const name = result.changed;
    const token = result.id;
    const changed = buildFilter(
      parseFilter(
        `@request.body.${name}:isset = true && @request.body.${name} != ${name}`,
      )!,
      r,
      now,
    );
    result.after = (sql) => sql.replaceAll(token, () => changed);
  }
  return result;
}

type TokenType = "identifier" | "text" | "number" | "function";

function tokenType(o: Operand): TokenType {
  if (o.kind === "call") return "function";
  if (o.kind !== "value") return "identifier";
  if (typeof o.value === "string") return "text";
  return typeof o.value === "number" ? "number" : "identifier";
}

export function call(
  o: Extract<Operand, { kind: "call" }>,
  resolve: (a: Operand) => Resolved,
): Resolved {
  const { args } = o;

  if (o.name === "geoDistance") {
    if (args.length !== 4)
      throw new FilterError(
        `[geoDistance] expected 4 arguments, got ${args.length}`,
      );
    const resolved = args.map((a, i) => {
      const type = tokenType(a);
      if (type !== "identifier" && type !== "number") {
        throw new FilterError(
          `[geoDistance] argument ${i} must be an identifier or number`,
        );
      }
      return resolve(a);
    });
    const [lonA, latA, lonB, latB] = resolved.map((a) => a.id);
    return {
      // clamped to avoid acos NULL from floating point rounding of identical points
      id:
        `(6371 * acos(min(1, max(-1, cos(radians(${latA})) * cos(radians(${latB})) * ` +
        `cos(radians(${lonB}) - radians(${lonA})) + sin(radians(${latA})) * sin(radians(${latB}))))))`,
      params: resolved.flatMap((a) => a.params),
      nullFallback: "disabled",
    };
  }

  if (o.name === "strftime") {
    if (args.length < 1)
      throw new FilterError(
        `[strftime] expected at least 1 arguments, got ${args.length}`,
      );
    if (args.length > 10)
      throw new FilterError(
        `[strftime] too many arguments (max allowed 10, got ${args.length})`,
      );
    if (tokenType(args[0]!) !== "text")
      throw new FilterError(
        "[strftime] expects the first argument to be a format string",
      );
    const format = resolve(args[0]!);
    if (args.length === 1)
      return {
        ...format,
        id: `strftime(${format.id})`,
        nullFallback: "enforced",
      };

    if (tokenType(args[1]!) === "function") {
      throw new FilterError(
        "[strftime] expects the second argument to be of a valid time-value type",
      );
    }
    const time = resolve(args[1]!);
    const modifiers = args.slice(2).map((a, i) => {
      if (tokenType(a) !== "text")
        throw new FilterError(
          `[strftime] invalid modifier argument ${i} - can be only string`,
        );
      return resolve(a);
    });
    const ids = [format.id, time.id, ...modifiers.map((m) => m.id)];
    const result: Resolved = {
      id: `strftime(${ids.join(",")})`,
      params: [format, time, ...modifiers].flatMap((a) => a.params),
      nullFallback: "enforced",
    };
    if (time.multi) {
      ids[1] = time.multi.value;
      result.multi = time.multi;
      result.multi.value = `strftime(${ids.join(",")})`;
    }
    return result;
  }

  throw new FilterError(`unknown function "${o.name}"`);
}

const not = (sql: string) => `NOT (${sql})`;

function compare(r: Resolver, left: Resolved, op: Op, right: Resolved): string {
  const anyMatch = op.startsWith("?");
  const sign = anyMatch ? op.slice(1) : op;
  let sql: string;

  if (sign === "=" || sign === "!=") {
    sql = equal(r, sign === "=", left, right);
  } else if (sign === "~" || sign === "!~") {
    const like = sign === "~" ? "LIKE" : "NOT LIKE";
    if (right.params.length === 0) {
      // the right side is a column, so wrap it for a contains match
      sql = `${left.id} ${like} ('%' || ${right.id} || '%') ESCAPE '\\'`;
    } else {
      for (const key of right.params)
        r.state.values.set(key, wrapLike(r.state.values.get(key)));
      sql = `${left.id} ${like} ${right.id} ESCAPE '\\'`;
    }
  } else {
    sql = `${left.id} ${sign} ${right.id}`;
  }

  if (!anyMatch) {
    if (left.multi && right.multi) {
      sql = `(${sql} AND ${manyVsMany(r, left, right, op)})`;
    } else if (left.multi) {
      sql = `(${sql} AND ${manyVsOne(r, left.multi, left.nullFallback, op, right, false)})`;
    } else if (right.multi) {
      sql = `(${sql} AND ${manyVsOne(r, right.multi, right.nullFallback, op, left, true)})`;
    }
  }

  if (left.after) sql = left.after(sql);
  if (right.after) sql = right.after(sql);
  return sql;
}

// Every value of a multi-value operand must satisfy the condition: no row may fail it.
function manyVsMany(
  r: Resolver,
  left: Resolved,
  right: Resolved,
  op: Op,
): string {
  const l = "__ml" + r.next();
  const m = "__mr" + r.next();
  const where = compare(
    r,
    {
      id: col(l, "multiMatchValue"),
      params: [],
      nullFallback: left.nullFallback,
    },
    op,
    {
      id: col(m, "multiMatchValue"),
      params: [],
      nullFallback: right.nullFallback,
      after: not,
    },
  );
  return `NOT EXISTS (SELECT 1 FROM (${multiMatchSql(left.multi!)}) ${quote(l)} LEFT JOIN (${multiMatchSql(right.multi!)}) ${quote(m)} WHERE ${where})`;
}

function manyVsOne(
  r: Resolver,
  multi: MultiMatch,
  nullFallback: NullFallback,
  op: Op,
  other: Resolved,
  inverse: boolean,
): string {
  const alias = "__sm" + r.next();
  const many: Resolved = {
    id: col(alias, "multiMatchValue"),
    params: [],
    nullFallback,
    after: not,
  };
  const one: Resolved = {
    id: other.id,
    params: other.params,
    nullFallback: "auto",
  };
  const where = inverse ? compare(r, one, op, many) : compare(r, many, op, one);
  return `NOT EXISTS (SELECT 1 FROM (${multiMatchSql(multi)}) ${quote(alias)} WHERE ${where})`;
}

const EMPTY_IDS = new Set(["", "null", "''", '""', "``"]);
const LITERAL_IDS = new Set(["1", "0", "false", "true"]);

const isEmptyId = (x: Resolved) => EMPTY_IDS.has(x.id.toLowerCase());

const hasEmptyParam = (r: Resolver, x: Resolved) =>
  x.params.some((key) => {
    const value = r.state.values.get(key);
    return value === null || value === undefined || value === "";
  });

const isKnownNonEmpty = (r: Resolver, x: Resolved) =>
  x.nullFallback !== "enforced" &&
  (LITERAL_IDS.has(x.id.toLowerCase()) ||
    (x.params.length > 0 && !hasEmptyParam(r, x) && !isEmptyId(x)));

// Treats NULL and '' as equal while keeping direct comparisons where one side is known non-empty.
function equal(
  r: Resolver,
  eq: boolean,
  left: Resolved,
  right: Resolved,
): string {
  const op = eq ? "=" : "IS NOT";
  const nullOp = eq ? "IS" : "IS NOT";
  const join = eq ? "OR" : "AND";
  const isNull = eq ? "IS NULL" : "IS NOT NULL";

  if (left.nullFallback === "disabled" || right.nullFallback === "disabled") {
    return `${left.id} ${nullOp} ${right.id}`;
  }

  const empty = (x: Resolved) =>
    isEmptyId(x) ||
    (x.nullFallback === "auto" && x.params.length === 1 && hasEmptyParam(r, x));
  const leftEmpty = empty(left);
  const rightEmpty = empty(right);

  if (leftEmpty && rightEmpty) return `'' ${op} ''`;
  if (isKnownNonEmpty(r, left) || isKnownNonEmpty(r, right)) {
    return `${leftEmpty ? "''" : left.id} ${op} ${rightEmpty ? "''" : right.id}`;
  }
  if (leftEmpty) return `('' ${op} ${right.id} ${join} ${right.id} ${isNull})`;
  if (rightEmpty) return `(${left.id} ${op} '' ${join} ${left.id} ${isNull})`;
  return `COALESCE(${left.id}, '') ${op} COALESCE(${right.id}, '')`;
}

export function wrapLike(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (containsUnescaped(s, "%")) return s;
  return `%${escapeUnescaped(s, ["\\", "%", "_"])}%`;
}

function containsUnescaped(s: string, ch: string): boolean {
  let prev = "";
  for (const c of s) {
    if (c === ch && prev !== "\\") return true;
    prev = c === "\\" && prev === "\\" ? "" : c;
  }
  return false;
}

function escapeUnescaped(s: string, chars: string[]): string {
  const rs = [...s];
  const out: string[] = [];
  let match = false;
  for (let i = rs.length - 1; i >= 0; i--) {
    if (match) {
      if (rs[i] !== "\\") out.push("\\");
      match = false;
    } else {
      match = chars.includes(rs[i]!);
    }
    out.push(rs[i]!);
    if (i === 0 && match) out.push("\\");
  }
  return out.reverse().join("");
}
