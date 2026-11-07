import { beforeAll, describe, expect, test } from "bun:test";
import { quote } from "../collections/ddl";
import { CollectionStore } from "../collections/store";
import { type Db, openDb } from "../db";
import {
  type CompileCtx,
  QueryCompiler,
  type RequestInfo,
  compileFilter,
  compileSort,
} from "./compile";
import { macroValue } from "./macros";
import { FilterError, parseFilter, parseSort } from "./parse";

const now = () => new Date("2026-01-15T10:00:00.000Z");

let db: Db;
let store: CollectionStore;

const request = (
  auth: Record<string, unknown> | null,
  authCollection: string | null,
  body = {},
): RequestInfo => ({
  auth,
  authCollection,
  body,
  query: {},
  headers: {},
  method: "GET",
  context: "default",
});
const superuser = request({ id: "su", email: "su@x.com" }, "_superusers");
const user1 = request(
  { id: "u1", email: "a@x.com", name: "Al", verified: false },
  "users",
);

const ctx = (
  collection = "posts",
  req: RequestInfo | null = superuser,
): CompileCtx => ({
  collection: store.find(collection)!,
  store,
  request: req,
  now,
});

function run(
  collection: string,
  c: { sql: string; params: unknown[]; joins: string[] },
  orderBy = "1",
): string {
  const table = quote(collection);
  return db
    .query<{ id: string }>(
      `SELECT DISTINCT ${table}.id FROM ${table} ${c.joins.join(" ")} WHERE ${c.sql} ORDER BY ${orderBy}`,
      c.params,
    )
    .map((r) => r.id)
    .join(",");
}

const ids = (
  filter: string,
  collection = "posts",
  req: RequestInfo | null = superuser,
) => run(collection, compileFilter(parseFilter(filter), ctx(collection, req)));

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.run(
    `INSERT INTO ${quote(table)} (${keys.map(quote).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    Object.values(row).map((v) =>
      Array.isArray(v) || (v !== null && typeof v === "object")
        ? JSON.stringify(v)
        : v,
    ),
  );
}

beforeAll(() => {
  db = openDb(":memory:");
  store = new CollectionStore(db, now);
  const users = store.save({
    name: "users",
    type: "auth",
    listRule: "",
    fields: [
      { name: "name", type: "text" },
      { name: "created", type: "autodate", onCreate: true },
    ] as any,
  });
  store.save({
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      {
        name: "tags",
        type: "select",
        maxSelect: 3,
        values: ["x", "y", "ab", "ac", "b"],
      },
      {
        name: "author",
        type: "relation",
        collectionId: users.id,
        maxSelect: 1,
      },
      {
        name: "owners",
        type: "relation",
        collectionId: users.id,
        maxSelect: 5,
      },
      { name: "views", type: "number" },
      { name: "meta", type: "json" },
      { name: "published", type: "date" },
      { name: "secret", type: "text", hidden: true },
      { name: "created", type: "autodate", onCreate: true },
    ] as any,
  });

  store.save({
    name: "codes",
    fields: [{ name: "code", type: "text" }] as any,
  });
  insert("codes", { id: "c1", code: "1" });

  const user = {
    password: "hash",
    verified: 0,
    created: "2026-11-08 00:00:00.000Z",
  };
  insert("users", {
    ...user,
    id: "u1",
    email: "a@x.com",
    emailVisibility: 0,
    name: "Al",
    tokenKey: "k1",
  });
  insert("users", {
    ...user,
    id: "u2",
    email: "b@x.com",
    emailVisibility: 1,
    name: "Bo",
    tokenKey: "k2",
  });
  insert("posts", {
    id: "p1",
    title: "a",
    tags: ["x", "y"],
    author: "u1",
    owners: ["u1", "u2"],
    views: 1,
    published: "2026-01-10 08:00:00.000Z",
    secret: "s1",
    created: "2026-01-14 12:00:00.000Z",
  });
  insert("posts", {
    id: "p2",
    title: "b_2",
    tags: ["ab", "ac"],
    author: "u2",
    owners: ["u2"],
    views: 5,
    meta: { a: 2, b: "x" },
    published: "2026-01-15 09:00:00.000Z",
    created: "2026-01-15 09:00:00.000Z",
  });
  insert("posts", {
    id: "p3",
    tags: [],
    owners: [],
    created: "2026-01-15 09:30:00.000Z",
  });
  insert("posts", {
    id: "p4",
    title: "c",
    tags: ["x"],
    author: "u1",
    owners: ["u1"],
    views: 10,
    meta: { a: 1 },
    published: "2025-12-31 23:00:00.000Z",
    created: "2026-01-01 00:00:00.000Z",
  });
});

describe("compileFilter", () => {
  test("plain field equality returns only matching ids", () => {
    expect(ids(`title="a"`)).toBe("p1");
  });

  test("multi-value fields behave as PB", () => {
    expect(ids(`tags?="x"`)).toBe("");
    expect(ids(`tags:each?="x"`)).toBe("p1,p4");
    expect(ids(`tags:each="x"`)).toBe("p4");
    expect(ids(`tags:length>1`)).toBe("p1,p2");
    expect(ids(`tags:each~"a"`)).toBe("p2");
  });

  test("relation path follows the relation", () => {
    expect(ids(`author.email="a@x.com"`)).toBe("p1,p4");
  });

  test("@request.auth.id compares against the auth record", () => {
    expect(ids("@request.auth.id = author", "posts", user1)).toBe("p1,p4");
    expect(ids("@request.auth.id = author", "posts", null)).toBe("p3");
    expect(
      ids("@request.auth.id = author && author != ''", "posts", null),
    ).toBe("");
  });

  test("@collection joins require every row to match unless ?= is used", () => {
    expect(
      ids(
        `@collection.users.email = "a@x.com" && @collection.users.id = author`,
      ),
    ).toBe("");
    expect(
      ids(
        `@collection.users.email ?= "a@x.com" && @collection.users.id ?= author`,
      ),
    ).toBe("p1,p4");
  });

  test("macros use the injected clock", () => {
    expect(ids("created >= @todayStart")).toBe("p2,p3");
    expect(ids("published < @now && published != ''")).toBe("p1,p2,p4");
  });

  test("null and empty string are equivalent", () => {
    expect(ids("title = null")).toBe("p3");
    expect(ids(`title = ""`)).toBe("p3");
    expect(ids("title != null")).toBe("p1,p2,p4");
  });

  test("values never reach the sql text", () => {
    const value = `x" OR 1=1 --`;
    const compiled = compileFilter(
      parseFilter(`title="x\\" OR 1=1 --"`),
      ctx(),
    );
    expect(run("posts", compiled)).toBe("");
    expect(compiled.sql).not.toContain("1=1");
    expect(compiled.sql).not.toContain("OR 1");
    expect(compiled.params).toEqual([value]);
  });

  test("unknown identifiers throw FilterError", () => {
    for (const filter of [
      "nope = 1",
      "@foo = 1",
      "author.nope = 1",
      "title:nope = 1",
      "views.x = 1",
      "unknown(1) = 1",
    ]) {
      expect(() => ids(filter)).toThrow(FilterError);
    }
  });

  test("the same shape with different values compiles to the same sql", () => {
    const a = compileFilter(
      parseFilter(`title = "a" && author.name ~ "x" && created > @now`),
      ctx(),
    );
    const b = compileFilter(
      parseFilter(`title = "b" && author.name ~ "y" && created > @now`),
      ctx(),
    );
    expect(a.sql).toBe(b.sql);
    expect(a.joins).toEqual(b.joins);
    expect(a.params).not.toEqual(b.params);
  });

  test("number literals bind as float64 like PB", () => {
    expect(ids("code = 1", "codes")).toBe("");
    expect(ids(`code = "1"`, "codes")).toBe("c1");
    expect(ids("code > 0", "codes")).toBe("c1");
  });

  test("null expression matches everything", () => {
    expect(run("posts", compileFilter(null, ctx()))).toBe("p1,p2,p3,p4");
  });

  test("more than 200 expressions throw", () => {
    const filter = Array.from({ length: 201 }, () => "views > 0").join(" || ");
    expect(() => ids(filter)).toThrow(FilterError);
  });
});

// Expected ids recorded from a PocketBase v0.41.1 binary on the same data, queried as a superuser.
const parity: [string, string, string][] = [
  ["posts", `tags:each!="x"`, "p2,p3"],
  ["posts", `tags:each?!="x"`, "p1,p2,p3"],
  ["posts", "tags:length=0", "p3"],
  ["posts", `tags~"a"`, "p2"],
  [
    "posts",
    `@collection.users:u.name ?= "Bo" && @collection.users:u.id ?= author`,
    "p2",
  ],
  ["posts", "null = title", "p3"],
  ["posts", `views > 2 && title ~ "c"`, "p4"],
  ["posts", `views >= 5 || title = ""`, "p2,p3,p4"],
  ["posts", `title ~ "b_"`, "p2"],
  ["posts", `title ~ "b%"`, "p2"],
  ["posts", `title !~ "b"`, "p1,p3,p4"],
  ["posts", `title ~ "_"`, "p2"],
  ["posts", `author.name:lower = "al"`, "p1,p4"],
  ["posts", `title:lower = "A"`, ""],
  ["posts", "meta.a = 1", "p4"],
  ["posts", "meta.a > 0", "p2,p4"],
  ["posts", `meta.b = "x"`, "p2"],
  ["posts", "meta = null", "p1,p3"],
  ["posts", "meta != null", "p2,p4"],
  ["posts", `owners.name ?= "Al"`, "p1,p4"],
  ["posts", `owners.name = "Al"`, "p4"],
  ["posts", `owners.name != "Al"`, "p2,p3"],
  ["posts", "owners:length = 2", "p1"],
  ["posts", `owners.email ?~ "b@"`, "p1,p2"],
  ["posts", `owners.id ?= "u2"`, "p1,p2"],
  ["posts", `owners ?= "u2"`, ""],
  ["posts", `owners ~ "u2"`, "p1,p2"],
  ["posts", `owners:each = "u1"`, "p4"],
  ["posts", `author.id = "u1"`, "p1,p4"],
  ["posts", `author = "u1"`, "p1,p4"],
  ["posts", `author != "u1"`, "p2,p3"],
  ["posts", `author.posts_via_author.title ?= "c"`, "p1,p4"],
  ["posts", `author.posts_via_author.title = "c"`, ""],
  ["posts", `strftime('%Y-%m', published) = "2026-01"`, "p1,p2"],
  ["posts", `strftime('%Y', published) = ""`, "p3"],
  ["posts", `strftime('%Y') != ""`, "p1,p2,p3,p4"],
  ["posts", `strftime('%Y-%m', owners.created) ?= "2026-11"`, "p1,p2,p4"],
  ["posts", "geoDistance(views, views, 0, 0) < 1000", "p1,p2,p3"],
  ["posts", "geoDistance(0, 0, 0, 0) = 0", "p1,p2,p3,p4"],
  ["posts", `@request.method = "GET"`, "p1,p2,p3,p4"],
  ["posts", `@request.context = "default"`, "p1,p2,p3,p4"],
  ["posts", `@request.auth.collectionName = "_superusers"`, "p1,p2,p3,p4"],
  ["posts", `@request.auth.id != ""`, "p1,p2,p3,p4"],
  ["posts", "@request.body.title:isset = false", "p1,p2,p3,p4"],
  ["posts", "@request.query.nope = null", "p1,p2,p3,p4"],
  ["posts", `@request.headers.x_token = "abc"`, ""],
  ["posts", "@request.body.nope = null", "p1,p2,p3,p4"],
  ["posts", `secret = "s1"`, "p1"],
  ["posts", `views = "5"`, "p2"],
  ["posts", "1 = 1", "p1,p2,p3,p4"],
  ["posts", `"a" = title`, "p1"],
  ["posts", "NULL = title", "p3"],
  ["posts", "True = 1", "p1,p2,p3,p4"],
  ["users", `posts_via_author.title ?= "a"`, "u1"],
  ["users", `posts_via_author.title = "a"`, ""],
  ["users", `posts_via_author.title = "b_2"`, "u2"],
  ["users", `posts_via_owners.title ?= "c"`, "u1"],
  ["users", `posts_via_owners.title = "c"`, ""],
  ["users", "posts_via_owners.views:length > 0", "u1,u2"],
  ["users", `email = "a@x.com"`, "u1"],
  ["users", `password != ""`, "u1,u2"],
];

const parityErrors = [
  `tags:each:lower = "x"`,
  "geoDistance(1, 2, 3) = 1",
  "strftime(title) = 1",
  "@rowid = 1",
];

describe("PocketBase parity", () => {
  test.each(parity)("%s: %s", (collection, filter, expected) => {
    expect(ids(filter, collection)).toBe(expected);
  });

  test.each(parityErrors)("%s throws", (filter) => {
    expect(() => ids(filter)).toThrow(FilterError);
  });
});

describe("@request.body", () => {
  const body = (data: Record<string, unknown>) =>
    request({ id: "u1" }, "users", data);

  test(":changed compares the body value with the stored one", () => {
    expect(
      ids("@request.body.title:changed = true", "posts", body({ title: "a" })),
    ).toBe("p2,p3,p4");
    expect(
      ids("@request.body.title:changed = false", "posts", body({ title: "a" })),
    ).toBe("p1");
    expect(ids("@request.body.title:changed = true", "posts", body({}))).toBe(
      "",
    );
  });

  test(":isset, :length, :lower and :each read the body", () => {
    expect(
      ids("@request.body.title:isset = true", "posts", body({ title: "" })),
    ).toBe("p1,p2,p3,p4");
    expect(
      ids(
        "@request.body.tags:length = 2 && views = 1",
        "posts",
        body({ tags: ["x", "y"] }),
      ),
    ).toBe("p1");
    expect(
      ids(
        `@request.body.title:lower = "abc" && views = 1`,
        "posts",
        body({ title: "ABC" }),
      ),
    ).toBe("p1");
    expect(
      ids(
        `@request.body.tags:each ?= "y" && views = 1`,
        "posts",
        body({ tags: ["x", "y"] }),
      ),
    ).toBe("p1");
    expect(
      ids(
        `@request.body.tags:each = "y" && views = 1`,
        "posts",
        body({ tags: ["x", "y"] }),
      ),
    ).toBe("");
  });

  test("number fields cast numeric strings", () => {
    expect(
      ids("@request.body.views = views", "posts", body({ views: "5" })),
    ).toBe("p2");
  });

  test("relation fields join the referenced records", () => {
    expect(
      ids(`@request.body.author.name = "Bo"`, "posts", body({ author: "u2" })),
    ).toBe("p1,p2,p3,p4");
    expect(
      ids(
        `@request.body.owners.name ?= "Al"`,
        "posts",
        body({ owners: ["u1", "u2"] }),
      ),
    ).toBe("p1,p2,p3,p4");
    expect(
      ids(
        `@request.body.owners.name = "Al"`,
        "posts",
        body({ owners: ["u1", "u2"] }),
      ),
    ).toBe("");
    expect(ids(`@request.body.author.name = null`, "posts", body({}))).toBe(
      "p1,p2,p3,p4",
    );
  });

  test("non-relation auth fields join the auth collection", () => {
    expect(ids(`@request.auth.name = "Al" && views = 1`, "posts", user1)).toBe(
      "p1",
    );
    expect(ids(`@request.auth.name = "Bo"`, "posts", user1)).toBe("");
  });
});

describe("client filters without hidden field access", () => {
  const compile = (filter: string, rule: string | null = "") => {
    store.save({ ...store.find("users")!, listRule: rule });
    const q = new QueryCompiler(ctx("posts", user1));
    q.allowHidden = false;
    return run("posts", q.filter(parseFilter(filter)).build());
  };

  test("hidden fields are not filterable", () => {
    expect(() => compile(`secret = "s1"`)).toThrow(FilterError);
  });

  test("auth emails are matched only when visible", () => {
    expect(compile(`author.email = "a@x.com"`)).toBe("");
    expect(compile(`author.email = "b@x.com"`)).toBe("p2");
  });

  test("joined collections apply their list rule", () => {
    expect(() => compile(`author.name = "Al"`, null)).toThrow(FilterError);
    expect(compile(`author.name = "Al"`, `name = "Bo"`)).toBe("");
    expect(compile(`title != "" || author.name = "x"`, `name = "Bo"`)).toBe(
      "p2",
    );
    expect(compile(`author.name != ""`, `name = "Bo"`)).toBe("p2");
    store.save({ ...store.find("users")!, listRule: "" });
  });

  test("the rule filter keeps hidden field access", () => {
    const q = new QueryCompiler(ctx("posts", user1));
    q.filter(parseFilter(`secret = "s1" || author = @request.auth.id`));
    q.allowHidden = false;
    q.filter(parseFilter("views > 0")).sort(parseSort("-views"));
    const compiled = q.build();
    expect(run("posts", compiled, compiled.orderBy)).toBe("p4,p1");
  });
});

describe("compileSort", () => {
  test("builds an ORDER BY list", () => {
    expect(compileSort(parseSort("-views,title"), ctx())).toBe(
      "`posts`.`views` DESC, `posts`.`title` ASC",
    );
    expect(compileSort(parseSort("@random,-@rowid"), ctx())).toBe(
      "RANDOM(), `posts`.`_rowid_` DESC",
    );
  });

  test("rejects unknown and non-column fields", () => {
    expect(() => compileSort(parseSort("nope"), ctx())).toThrow(FilterError);
    expect(() => compileSort(parseSort("@request.method"), ctx())).toThrow(
      FilterError,
    );
  });

  test("relation sorts need the joins from QueryCompiler", () => {
    expect(() => compileSort(parseSort("author.name"), ctx())).toThrow(
      FilterError,
    );
    const compiled = new QueryCompiler(ctx())
      .filter(parseFilter("views > 0"))
      .sort(parseSort("-author.name,views"))
      .build();
    expect(run("posts", compiled, compiled.orderBy)).toBe("p2,p1,p4");
  });
});

describe("macros", () => {
  test("resolve relative to now", () => {
    const at = () => new Date("2024-02-10T13:14:15.678Z");
    expect(
      Object.fromEntries(
        [
          "@now",
          "@yesterday",
          "@tomorrow",
          "@second",
          "@minute",
          "@hour",
          "@day",
          "@month",
          "@weekday",
          "@year",
          "@todayStart",
          "@todayEnd",
          "@monthStart",
          "@monthEnd",
          "@yearStart",
          "@yearEnd",
        ].map((name) => [name, macroValue(name, at)]),
      ),
    ).toEqual({
      "@now": "2024-02-10 13:14:15.678Z",
      "@yesterday": "2024-02-09 13:14:15.678Z",
      "@tomorrow": "2024-02-11 13:14:15.678Z",
      "@second": 15,
      "@minute": 14,
      "@hour": 13,
      "@day": 10,
      "@month": 2,
      "@weekday": 6,
      "@year": 2024,
      "@todayStart": "2024-02-10 00:00:00.000Z",
      "@todayEnd": "2024-02-10 23:59:59.999Z",
      "@monthStart": "2024-02-01 00:00:00.000Z",
      "@monthEnd": "2024-02-29 23:59:59.999Z",
      "@yearStart": "2024-01-01 00:00:00.000Z",
      "@yearEnd": "2024-12-31 23:59:59.999Z",
    });
  });

  test("unknown macros throw FilterError", () => {
    expect(() => macroValue("@nope", now)).toThrow(FilterError);
    expect(() => macroValue("@constructor", now)).toThrow(FilterError);
  });
});
