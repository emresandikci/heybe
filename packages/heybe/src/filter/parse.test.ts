import { describe, expect, test } from "bun:test";
import { toAst, toFilter } from "@heybe/query";
import { FilterError, parseFilter, parseSort } from "./parse";

describe("parseFilter", () => {
  test("empty input gives null", () => {
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("  \n ")).toBeNull();
  });

  test("groups and precedence match toAst", () => {
    expect(parseFilter(`status="a" && (x>1 || y~'b')`)).toEqual(
      toAst({ status: "a", OR: [{ x: { gt: 1 } }, { y: { like: "b" } }] }),
    );
  });

  test("&& binds tighter than ||", () => {
    expect(parseFilter("a=1 || b=2 && c=3")).toEqual(
      toAst({ OR: [{ a: 1 }, { b: 2, c: 3 }] }),
    );
  });

  test("same-kind parenthesized groups flatten", () => {
    expect(parseFilter("a=1 && (b=2 && c=3)")).toEqual(
      toAst({ a: 1, b: 2, c: 3 }),
    );
    expect(parseFilter("(a=1)")).toEqual(toAst({ a: 1 }));
  });

  test("round trip", () => {
    const objects: Record<string, unknown>[] = [
      { status: "active", comments: { gt: 50 } },
      {
        OR: [{ title: { like: "a" } }, { tags: { anyLike: "b" } }],
        status: "x",
      },
      { OR: [{ a: 1, b: 2 }, { c: 3 }] },
      { OR: [{ v: { gt: 1, lt: 5 } }, { v: 10 }] },
      { AND: [{ a: 1, b: 2 }, { c: 3 }] },
      { title: 'a"b\\c' },
      { title: "x\ny\tz\r'\"\\\b\f\u0001\u2028" },
      { created: { gte: "@todayStart" } },
      { title: "@foo" },
      { created: { lt: new Date("2026-12-31T00:00:00Z") } },
      { title: { like: "News", insensitive: true } },
      { tags: { length: { gt: 2 } } },
      { tags: { each: { like: "x" } } },
      { title: { empty: true } },
      { title: { empty: false } },
      { t: { like: "A", neq: "B", insensitive: true } },
      { author: { team: { name: { like: "a" } } } },
      { done: false },
      {
        n: {
          eq: 1,
          neq: 1,
          gt: 1,
          gte: 1,
          lt: 1,
          lte: 1,
          like: "a",
          notLike: "a",
          anyEq: 1,
          anyNeq: 1,
          anyGt: 1,
          anyGte: 1,
          anyLt: 1,
          anyLte: 1,
          anyLike: "a",
          anyNotLike: "a",
        },
      },
    ];
    for (const o of objects) {
      const ast = toAst(o);
      expect(parseFilter(toFilter(ast))).toEqual(ast);
    }
  });

  test("macro operand", () => {
    expect(parseFilter("a = @now")).toEqual({
      kind: "cmp",
      op: "=",
      left: { kind: "field", path: "a" },
      right: { kind: "macro", name: "@now" },
    });
  });

  test("@request path is a field", () => {
    expect(parseFilter("@request.auth.id != ''")).toEqual({
      kind: "cmp",
      op: "!=",
      left: { kind: "field", path: "@request.auth.id" },
      right: { kind: "value", value: "" },
    });
  });

  test("function call operand", () => {
    expect(parseFilter("strftime('%Y', created) = '2026'")).toEqual({
      kind: "cmp",
      op: "=",
      left: {
        kind: "call",
        name: "strftime",
        args: [
          { kind: "value", value: "%Y" },
          { kind: "field", path: "created" },
        ],
      },
      right: { kind: "value", value: "2026" },
    });
  });

  test("literals, modifiers and comments", () => {
    expect(
      parseFilter("a:lower ?= -1.5 // note\n && b = null && c = true"),
    ).toEqual({
      kind: "and",
      items: [
        {
          kind: "cmp",
          op: "?=",
          left: { kind: "field", path: "a:lower" },
          right: { kind: "value", value: -1.5 },
        },
        {
          kind: "cmp",
          op: "=",
          left: { kind: "field", path: "b" },
          right: { kind: "value", value: null },
        },
        {
          kind: "cmp",
          op: "=",
          left: { kind: "field", path: "c" },
          right: { kind: "value", value: true },
        },
      ],
    });
  });

  test("escaped quotes", () => {
    expect(parseFilter(`a = 'it\\'s'`)).toMatchObject({
      right: { value: "it's" },
    });
  });

  test("string escapes follow fexpr", () => {
    const value = (filter: string) =>
      (parseFilter(filter) as { right: { value: unknown } }).right.value;
    expect(value(String.raw`a = "x\ny\tz\r"`)).toBe("x\ny\tz\r");
    expect(value(String.raw`a = 'x\"y'`)).toBe('x"y');
    expect(value(String.raw`a = "x\'y"`)).toBe("x'y");
    expect(value(String.raw`a = "x\\y"`)).toBe("x\\y");
    expect(value(String.raw`a = "x\by\u0041"`)).toBe(String.raw`x\by\u0041`);
    expect(parseFilter(`a = "é😀" && b = 'x'`)).toEqual(
      toAst({ a: "é😀", b: "x" }),
    );
  });

  test("inherited object keys are plain fields", () => {
    expect(parseFilter("constructor = 1")).toMatchObject({
      left: { kind: "field", path: "constructor" },
    });
    expect(parseFilter("a = toString")).toMatchObject({
      right: { kind: "field", path: "toString" },
    });
    expect(parseFilter("__proto__ = 1")).toMatchObject({
      left: { kind: "field", path: "__proto__" },
    });
  });

  test("nesting depth is limited", () => {
    const nest = (n: number) => `${"(".repeat(n)}a=1${")".repeat(n)}`;
    expect(parseFilter(nest(64))).not.toBeNull();
    expect(() => parseFilter(nest(65))).toThrow(FilterError);
    expect(() => parseFilter("(".repeat(20000))).toThrow(FilterError);
    expect(() => parseFilter(`a = ${"f(".repeat(20000)}`)).toThrow(FilterError);
  });

  test("errors", () => {
    for (const bad of [
      'a = "x',
      "a = 1 &&",
      "a = ",
      "a 1",
      "(a = 1",
      "a = 1)",
      "a = 1 b = 2",
      "a = f(1",
      "a # 1",
    ]) {
      expect(() => parseFilter(bad)).toThrow(FilterError);
    }
  });
});

describe("parseFilter syntax gate", () => {
  test.each([
    ["a = +1", "unexpected character '+'"],
    [
      "f(g(h(i(j(a))))) = 1",
      'invalid identifier argument "g" in function "f": invalid identifier argument "h" in function "g": invalid identifier argument "i" in function "h": max nested function arguments reached (max: 3)',
    ],
    ["a = 1\r&& b = 2", "unexpected character '\\r'"],
  ])("rejects %j like PB", (input, message) => {
    expect(() => parseFilter(input)).toThrow(new FilterError(message));
  });
});

describe("parseSort", () => {
  test("prefixes and specials", () => {
    expect(parseSort("-created,title,@random")).toEqual([
      { field: "created", dir: "DESC" },
      { field: "title", dir: "ASC" },
      { field: "@random", dir: "ASC" },
    ]);
    expect(parseSort("+a, -@rowid")).toEqual([
      { field: "a", dir: "ASC" },
      { field: "@rowid", dir: "DESC" },
    ]);
    expect(parseSort("")).toEqual([]);
    for (const bad of ["-", "+", "--a"]) {
      expect(() => parseSort(bad)).toThrow(FilterError);
    }
  });
});
