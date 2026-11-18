import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type App } from "../app";
import { testApp } from "../test-app";
import { ValidationError } from "../util";
import {
  dryRunView,
  findRecordByViewFile,
  inferViewFields,
  normalizeViewSelectQuery,
  saveView,
} from "./view";

let app: App;

const autodates = [
  { name: "created", type: "autodate", onCreate: true, onUpdate: false },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
];

beforeEach(async () => {
  app = testApp({ now: () => new Date("2026-01-01") });
  const demo2 = await app.collections.save({
    name: "demo2",
    fields: [{ name: "text", type: "text" }, ...autodates] as any,
  });
  await app.collections.save({
    name: "demo1",
    fields: [
      { name: "text", type: "text" },
      { name: "bool", type: "bool" },
      { name: "url", type: "url" },
      { name: "select_one", type: "select", values: ["a"], maxSelect: 1 },
      { name: "select_many", type: "select", values: ["a", "b"], maxSelect: 2 },
      { name: "file_one", type: "file", maxSelect: 1 },
      { name: "file_many", type: "file", maxSelect: 2 },
      { name: "number", type: "number" },
      { name: "email", type: "email" },
      { name: "datetime", type: "date" },
      { name: "json", type: "json" },
      {
        name: "rel_one",
        type: "relation",
        collectionId: demo2.id,
        maxSelect: 1,
      },
      {
        name: "rel_many",
        type: "relation",
        collectionId: demo2.id,
        maxSelect: 5,
      },
      ...autodates,
    ] as any,
  });
  await app.collections.save({ name: "demo3" });
  await app.collections.save({ name: "demo4" });
});
afterEach(() => app.close());

const infer = (query: string): Record<string, string> =>
  Object.fromEntries(
    inferViewFields(app.db, app.collections, query).map((f) => [
      f.name,
      f.type,
    ]),
  );

const objectNames = () =>
  app.db
    .query<{ name: string }>("SELECT name FROM sqlite_master ORDER BY name")
    .map((r) => r.name);

// adapted from PB core/view_test.go TestCreateViewFields
describe("inferViewFields", () => {
  test.each([
    ["empty query", ""],
    ["invalid query", "test 123456"],
    ["missing table", "select id from missing"],
    ["wildcard column", "select a.id, a.* from demo1 a"],
    ["wrapped wildcard column", "select * from (select 1 as id)"],
    ["no id", "select text, url, created, updated from demo1"],
  ])("%s fails", (_, query) => {
    expect(() => inferViewFields(app.db, app.collections, query)).toThrow();
  });

  test.each<[string, string, Record<string, string>]>([
    [
      "comments",
      `select
        -- test single line
        demo1.id,
        demo1.text,
        /* multi
         * line comment block */
        demo1.url, demo1.created, demo1.updated from/* inline */demo1
        -- comment before join
        join demo2 ON (
          -- comment inside join
          demo2.id = demo1.id
        )
        where (demo2.id = demo1.id)`,
      {
        id: "text",
        text: "text",
        url: "url",
        created: "autodate",
        updated: "autodate",
      },
    ],
    [
      "quoted identifiers",
      `select "id", "created", [text], \`bool\`, "select_many", "demo1"."file_many",
        \`demo1\`.\`number\` number_alias, "json", "rel_one",
        'single_quoted_custom_literal' as 'single_quoted_column'
      from demo1`,
      {
        id: "text",
        created: "autodate",
        text: "text",
        bool: "bool",
        select_many: "select",
        file_many: "file",
        number_alias: "number",
        json: "json",
        rel_one: "relation",
        single_quoted_column: "json",
      },
    ],
    [
      "indirect relations",
      "select a.id, b.id as bid, b.created from demo1 as a left join demo2 b",
      { id: "text", bid: "relation", created: "autodate" },
    ],
    [
      "multiple froms and joins",
      `select a.id as id, b.id as bid, lj.id cid, ij.id as did, a.bool,
        _superusers.id as eid, _superusers.email
      from demo1 a, demo2 as b
      left join demo3 lj on lj.id = 123
      inner join demo4 as ij on ij.id = 123
      join _superusers
      where 1=1
      group by a.id
      limit 10`,
      {
        id: "text",
        bid: "relation",
        cid: "relation",
        did: "relation",
        bool: "bool",
        eid: "relation",
        email: "email",
      },
    ],
    [
      "casts and aggregates",
      `select a.id, count(a.id) count, cast(a.id as int) cast_int,
        cast(a.id as real) cast_real, cast(a.id as text) cast_text,
        cast(a.id as boolean) cast_boolean, avg(a.id) avg, total(a.id) total
      from demo1 a`,
      {
        id: "text",
        count: "number",
        cast_int: "number",
        cast_real: "number",
        cast_text: "text",
        cast_boolean: "bool",
        avg: "json",
        total: "number",
      },
    ],
    [
      "unknown fields and aliases",
      `select id, id as id2, text as text_alias, "demo1"."bool" as bool_alias,
        created created_alias, 123 as custom
      from demo1`,
      {
        id: "text",
        id2: "relation",
        text_alias: "text",
        bool_alias: "bool",
        created_alias: "autodate",
        custom: "json",
      },
    ],
  ])("%s", (_, query, expected) => {
    expect(infer(query)).toEqual(expected);
  });

  test("keeps the column order, onlyInt for counts and clones source options", () => {
    const fields = inferViewFields(
      app.db,
      app.collections,
      "select distinct id as id2, id, count(id) as c, select_many as s, rel_many from demo1",
    );
    expect(fields.map((f) => f.name)).toEqual([
      "id2",
      "id",
      "c",
      "s",
      "rel_many",
    ]);
    expect(fields[0]).toMatchObject({ type: "relation", maxSelect: 1 });
    expect(fields[1]).toMatchObject({ id: "text3208210256", primaryKey: true });
    expect(fields[2]).toMatchObject({ type: "number", onlyInt: true });
    expect(fields[3]).toMatchObject({ values: ["a", "b"], maxSelect: 2 });
    expect(fields[3]!.id).toMatch(/^_clone_[A-Za-z0-9]{4}$/);
    expect(fields[4]).toMatchObject({ type: "relation", maxSelect: 5 });
  });

  test("hidden statements never run", () => {
    const before = objectNames();
    for (const query of [
      "select id from demo1; drop table demo3",
      "select 1 as id /* ' */); drop table demo3; select (1 /* ' */",
      "with x as (delete from demo1 returning id) select id from x",
      "attach database ':memory:' as x",
      "pragma table_info(demo1)",
    ]) {
      expect(() => inferViewFields(app.db, app.collections, query)).toThrow();
    }
    expect(objectNames()).toEqual(before);
  });

  // Only the first statement is ever compiled (Db.run prepares, it never execs),
  // which is what keeps a tail like this one from running: PB's own checks let it through.
  test("a tail hidden by a comment marker inside a string never runs", async () => {
    await app.records("demo2").create({ text: "a" });
    await app.records("demo2").create({ text: "b" });
    const rows = () => app.db.query("SELECT id FROM demo2").length;
    const before = objectNames();
    const hidden =
      "select id, '/*' as x from demo2) ; delete from demo2; select ('*/'";

    expect(normalizeViewSelectQuery(hidden)).toBe(hidden);
    expect(
      inferViewFields(app.db, app.collections, hidden).map((f) => f.name),
    ).toEqual(["id", "x"]);
    expect(() => dryRunView(app.db, app.collections, hidden, 10)).toThrow(
      "failed to retrieve query records",
    );
    await expect(
      app.collections.save({ name: "evil", type: "view", viewQuery: hidden }),
    ).rejects.toThrow(ValidationError);
    saveView(app.db, "evil", hidden);
    app.db.tx(() => app.db.run("DROP VIEW evil"));
    app.db.tx(() => app.db.run("select id from demo2; delete from demo2"));

    expect(rows()).toBe(2);
    expect(objectNames()).toEqual(before);
  });
});

test("normalizeViewSelectQuery rejects multiple statements", () => {
  expect(normalizeViewSelectQuery(" select 1;; ")).toBe("select 1");
  expect(normalizeViewSelectQuery("select ';'")).toBe("select ';'");
  expect(() => normalizeViewSelectQuery("select 1; select 2")).toThrow(
    "multiple statements are not supported",
  );
});

describe("dryRunView", () => {
  test("returns fields and a text id sample", async () => {
    await app.records("demo2").create({ text: "a" });
    const result = dryRunView(
      app.db,
      app.collections,
      "select (ROW_NUMBER() OVER()) as id, text from demo2",
      10,
    );
    expect(result.fields.map((f) => f.type)).toEqual(["text", "text"]);
    expect(result.sample).toMatchObject([{ id: "1", text: "a" }]);
  });

  test.each([
    ["select null as id from demo2", "empty or invalid ids"],
    ["select 'x' as id from demo2", "non-unique ids"],
    ["select id, 1 as expand from demo2", 'invalid field "expand" (1)'],
  ])("%s", async (query, message) => {
    await app.records("demo2").create({ text: "a" });
    await app.records("demo2").create({ text: "b" });
    expect(() => dryRunView(app.db, app.collections, query, 10)).toThrow(
      message,
    );
  });
});

describe("view collections", () => {
  test("save creates the view, renames recreate it and delete drops it", async () => {
    const v = await app.collections.save({
      name: "v1",
      type: "view",
      listRule: "",
      viewQuery: "select id, text from demo2",
    });
    expect(v.fields.map((f) => f.name)).toEqual(["id", "text"]);
    await app.collections.save({
      id: v.id,
      name: "v2",
      viewQuery: "select id from demo2",
    });
    expect(objectNames()).toContain("v2");
    expect(objectNames()).not.toContain("v1");
    expect(app.collections.find("v2")!.fields.map((f) => f.name)).toEqual([
      "id",
    ]);
    await app.collections.delete("v2");
    expect(objectNames()).not.toContain("v2");
  });

  test("a source used by a view cannot be deleted", async () => {
    await app.collections.save({
      name: "v1",
      type: "view",
      viewQuery: "select id from demo3",
    });
    await expect(app.collections.delete("demo3")).rejects.toThrow(
      "existing view dependency",
    );
    expect(app.collections.find("demo3")).not.toBeNull();
  });

  test("a column read by a view cannot be dropped or silently renamed", async () => {
    await app.collections.save({
      name: "v1",
      type: "view",
      viewQuery: "select id, text from demo2",
    });
    const demo2 = app.collections.find("demo2")!;
    await expect(
      app.collections.save({
        ...demo2,
        fields: demo2.fields.filter((f) => f.name !== "text"),
      }),
    ).rejects.toThrow(
      "failed to drop column text - SQL logic error: error in view v1",
    );
    // SQLite rewrites the view, the stored query is stale and PB only logs that
    const warn = spyOn(app.logger, "warn");
    await app.collections.save({
      ...demo2,
      fields: demo2.fields.map((f) =>
        f.name === "text" ? { ...f, name: "body" } : f,
      ),
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(app.db.query("SELECT * FROM v1")).toEqual([]);
  });

  test("import creates views after their sources", async () => {
    await app.collections.import(
      [
        { name: "iv", type: "view", viewQuery: "select id, title from isrc" },
        { name: "isrc", fields: [{ name: "title", type: "text" }] },
      ],
      false,
    );
    expect(app.collections.find("iv")!.fields.map((f) => f.name)).toEqual([
      "id",
      "title",
    ]);
  });

  test("onChange waits for the outermost operation to commit", async () => {
    await app.collections.save({
      name: "v1",
      type: "view",
      viewQuery: "select id from demo3",
    });
    await app.collections.save({
      name: "v2",
      type: "view",
      viewQuery: "select id, text from demo2",
    });
    // stale stored fields make the delete below resave v2 before v1 fails
    app.db.tx(() =>
      app.db.run(
        "UPDATE _collections SET data = json_set(data, '$.fields[1].hidden', json('true')) WHERE name = 'v2'",
      ),
    );
    let changes = 0;
    app.collections.onChange = () => changes++;

    // the nested v2 save logs v1's failure, as PB does
    const warn = spyOn(app.logger, "warn");
    await expect(app.collections.delete("demo3")).rejects.toThrow(
      "existing view dependency",
    );
    warn.mockRestore();
    expect(changes).toBe(0);
    expect(app.collections.find("v2")!.fields[1]!.hidden).toBe(true);

    await app.collections.save({
      ...app.collections.find("demo4")!,
      listRule: "",
    });
    // the demo4 save and the hooked v2 re-save after it commit separately, like PB
    expect(changes).toBe(2);
    expect(app.collections.find("v2")!.fields[1]!.hidden).toBe(false);
  });

  test("validation errors", async () => {
    try {
      await app.collections.save({
        name: "v1",
        type: "view",
        viewQuery: "select text from demo2",
      });
      throw new Error("expected a ValidationError");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).data).toEqual({
        fields: {
          code: "validation_missing_primary_key",
          message: 'Missing or invalid "id" PK field.',
        },
        viewQuery: {
          code: "validation_invalid_view_query",
          message:
            "Invalid query - missing required id column (you can use `(ROW_NUMBER() OVER()) as id` if you don't have one)",
        },
      });
    }
  });
});

describe("view edges seen on PB", () => {
  const queryError = async (viewQuery: string) => {
    try {
      await app.collections.save({ name: "bad", type: "view", viewQuery });
    } catch (e) {
      return ((e as ValidationError).data.viewQuery as any).message as string;
    }
    throw new Error("expected a ValidationError");
  };

  test("the query error is cut at 500 bytes, a split rune becomes U+FFFD per byte", async () => {
    const message = await queryError(`SELECT id FROM ab${"€".repeat(200)}`);
    expect(message.endsWith("€€€\uFFFD\uFFFD")).toBe(true);
    expect(
      new TextEncoder().encode(message.replace(/\uFFFD/g, "?")).length,
    ).toBe("Invalid query - ".length + 500);
    expect(await queryError(`SELECT id FROM a${"€".repeat(200)}`)).toEndWith(
      "€€€",
    );
  });
});

test("findRecordByViewFile resolves the source record through nested views", async () => {
  const demo1 = app.collections.find("demo1")!;
  app.db.tx(() =>
    app.db.run(
      "INSERT INTO demo1 (id, file_one, file_many) VALUES ('r1', 'a.txt', '[\"b.txt\",\"c.txt\"]')",
    ),
  );
  const inner = await app.collections.save({
    name: "inner_view",
    type: "view",
    viewQuery: "select id, file_one as f1, file_many from demo1",
  });
  const outer = await app.collections.save({
    name: "outer_view",
    type: "view",
    viewQuery: "select id, f1 as file, file_many as many from inner_view",
  });
  expect(
    findRecordByViewFile(app.db, app.collections, inner, "f1", "a.txt"),
  ).toEqual({
    collection: expect.objectContaining({ id: demo1.id }),
    id: "r1",
  });
  expect(
    findRecordByViewFile(app.db, app.collections, outer, "many", "c.txt")?.id,
  ).toBe("r1");
  expect(
    findRecordByViewFile(app.db, app.collections, outer, "file", "x.txt"),
  ).toBeNull();
});
