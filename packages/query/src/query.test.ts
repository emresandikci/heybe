import { describe, expect, test } from "bun:test";
import { toAst, toExpand, toFilter, toSort } from "./index.js";
import type { Expand, Relation, Where } from "./index.js";

const filter = (where: Where<Record<string, unknown>>) =>
  toFilter(toAst(where));

describe("toFilter(toAst())", () => {
  test("equality and operators joined with &&", () => {
    expect(filter({ status: "active", comments: { gt: 50 } })).toBe(
      'status="active" && comments>50',
    );
  });

  test("skips undefined, empty string, NaN and null", () => {
    expect(filter({ status: undefined, title: "", views: NaN, x: null })).toBe(
      "",
    );
  });

  test("OR group inside AND is parenthesized", () => {
    expect(
      filter({
        OR: [{ title: { like: "a" } }, { tags: { anyLike: "b" } }],
        status: "x",
      }),
    ).toBe('(title~"a" || tags?~"b") && status="x"');
  });

  test("empty groups vanish", () => {
    expect(filter({ OR: [{ title: undefined }] })).toBe("");
    expect(filter({ AND: [] })).toBe("");
    expect(filter({ OR: [undefined, null, "x", { a: 1 }] } as any)).toBe("a=1");
  });

  test("operator objects with only skipped operators vanish", () => {
    expect(filter({ a: { gt: undefined }, b: {} })).toBe("");
  });

  test("multiple conditions in a group child stay ANDed", () => {
    expect(filter({ OR: [{ a: 1, b: 2 }, { c: 3 }] })).toBe(
      "(a=1 && b=2) || c=3",
    );
    expect(filter({ OR: [{ v: { gt: 1, lt: 5 } }, { v: 10 }] })).toBe(
      "(v>1 && v<5) || v=10",
    );
    expect(filter({ AND: [{ a: 1, b: 2 }, { c: 3 }] })).toBe(
      "a=1 && b=2 && c=3",
    );
  });

  test("non-primitive and non-finite values are skipped", () => {
    expect(
      filter({
        x: { eq: ['a" || 1=1'] },
        y: ["z"],
        z: Infinity,
        w: { gt: -Infinity, eq: () => 1 },
      }),
    ).toBe("");
  });

  test("escapes quotes and backslashes", () => {
    expect(filter({ title: 'a"b\\c' })).toBe('title="a\\"b\\\\c"');
  });

  test("escapes only what the filter scanner decodes", () => {
    expect(filter({ title: "a\nb\tc\rd'e\bf\u0001" })).toBe(
      'title="a\\nb\\tc\\rd\'e\bf\u0001"',
    );
  });

  test("macros stay bare, unknown ones are strings", () => {
    expect(filter({ created: { gte: "@todayStart" } })).toBe(
      "created>=@todayStart",
    );
    expect(filter({ title: "@foo" })).toBe('title="@foo"');
  });

  test("dates", () => {
    expect(filter({ created: { lt: new Date("2026-12-31T00:00:00Z") } })).toBe(
      'created<"2026-12-31 00:00:00.000Z"',
    );
  });

  test("insensitive, length, each, empty", () => {
    expect(filter({ title: { like: "News", insensitive: true } })).toBe(
      'title:lower~"news"',
    );
    expect(filter({ tags: { length: { gt: 2 } } })).toBe("tags:length>2");
    expect(filter({ tags: { each: { like: "x" } } })).toBe('tags:each~"x"');
    expect(filter({ title: { empty: true } })).toBe('title=""');
    expect(filter({ title: { empty: false } })).toBe('title!=""');
  });

  test("insensitive applies to every string operator", () => {
    expect(filter({ t: { like: "A", neq: "B", insensitive: true } })).toBe(
      't:lower!="b" && t:lower~"a"',
    );
  });

  test("insensitive skips non-string values", () => {
    expect(filter({ views: { eq: 5, insensitive: true } })).toBe("views=5");
    expect(filter({ ok: { eq: true, insensitive: true } })).toBe("ok=true");
  });

  test("insensitive never lowers length", () => {
    expect(filter({ tags: { length: { gt: 2 }, insensitive: true } })).toBe(
      "tags:length>2",
    );
  });

  test("relation path", () => {
    expect(filter({ author: { name: "John" } })).toBe('author.name="John"');
    expect(filter({ author: { team: { name: { like: "a" } } } })).toBe(
      'author.team.name~"a"',
    );
  });

  test("all operators map in order", () => {
    expect(
      filter({
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
      }),
    ).toBe(
      'n=1 && n!=1 && n>1 && n>=1 && n<1 && n<=1 && n~"a" && n!~"a" && n?=1 && n?!=1 && n?>1 && n?>=1 && n?<1 && n?<=1 && n?~"a" && n?!~"a"',
    );
  });

  test("booleans and call operands render", () => {
    expect(filter({ done: false })).toBe("done=false");
    expect(
      toFilter({
        kind: "cmp",
        op: "=",
        left: {
          kind: "call",
          name: "geoDistance",
          args: [
            { kind: "field", path: "lon" },
            { kind: "value", value: 1 },
          ],
        },
        right: { kind: "value", value: null },
      }),
    ).toBe("geoDistance(lon,1)=null");
  });
});

describe("toSort", () => {
  test("array and object", () => {
    expect(toSort([{ created: "desc" }, { title: "asc" }])).toBe(
      "-created,title",
    );
    expect(toSort({ title: "asc" })).toBe("title");
    expect(toSort(undefined)).toBe("");
  });
});

describe("typed Where", () => {
  interface Post {
    title: string;
    views: number;
    tags: string[];
  }

  test("rejects unknown keys and wrong value types", () => {
    const ok: Where<Post> = { views: { gt: 1 }, tags: { anyLike: "a" } };
    // @ts-expect-error unknown key
    const unknownKey: Where<Post> = { nope: 1 };
    // @ts-expect-error wrong value type
    const wrongType: Where<Post> = { views: "x" };
    expect([ok, unknownKey, wrongType]).toHaveLength(3);
  });
});

describe("toExpand", () => {
  test.each([
    [undefined, ""],
    [{}, ""],
    [{ author: true }, "author"],
    [
      { author: true, comments_via_post: { user: true } },
      "author,comments_via_post.user",
    ],
    [{ a: { b: { c: true, d: true } }, e: true }, "a.b.c,a.b.d,e"],
    [{ a: {} }, "a"],
    [{ a: undefined, b: true }, "b"],
  ] as [Expand<unknown> | undefined, string][])("%j -> %s", (input, out) => {
    expect(toExpand(input)).toBe(out);
  });

  test("typed keys are relations and back-relations", () => {
    interface Post {
      title: string;
      author: Relation;
      tags: Relation[];
    }
    const ok: Expand<Post> = {
      author: true,
      tags: { owner: true },
      comments_via_post: { user: true },
    };
    // @ts-expect-error not a relation field
    const plain: Expand<Post> = { title: true };
    expect([ok, plain]).toHaveLength(2);
  });
});
