import { expect, test } from "bun:test";
import type { CollectionModel } from "@heybe/client";
import {
  createSuggest,
  logsSchema,
  type FilterSchema,
} from "./filter-language";

const users = {
  id: "u",
  name: "users",
  type: "auth",
  fields: [
    { name: "id", type: "text" },
    { name: "name", type: "text" },
    { name: "secret", type: "text", hidden: true },
    { name: "pw", type: "password" },
  ],
} as unknown as CollectionModel;

const comments = {
  id: "c",
  name: "comments",
  type: "base",
  fields: [
    { name: "id", type: "text" },
    { name: "post", type: "relation", collectionId: "p" },
    { name: "body", type: "text" },
  ],
} as unknown as CollectionModel;

const schema: FilterSchema = {
  collectionId: "p",
  fields: [
    { name: "id", type: "text" },
    { name: "created", type: "autodate" },
    { name: "updated", type: "autodate" },
    { name: "title", type: "text" },
    { name: "tags", type: "select" },
    { name: "files", type: "file" },
    { name: "pw", type: "password" },
    { name: "hid", type: "text", hidden: true },
    { name: "author", type: "relation", collectionId: "u" },
  ],
  collections: [users, comments],
};

const rules: FilterSchema = { ...schema, request: { body: true } };

function labels(s: FilterSchema, text: string) {
  const at = text.indexOf("^");
  const doc = text.replace("^", "");
  const result = createSuggest(s)(doc, at === -1 ? doc.length : at);
  return result?.options.map((o) => o.label) ?? [];
}

function from(s: FilterSchema, text: string) {
  return createSuggest(s)(text, text.length)?.from;
}

test("operand start offers fields, relation paths, back-relations, macros, functions and literals", () => {
  const list = labels(schema, "");
  expect(list).toEqual(
    expect.arrayContaining([
      "title",
      "id",
      "created",
      "updated",
      "author",
      "author.name",
      "author.id",
      "comments_via_post",
      "comments_via_post.body",
      "@now",
      "@yesterday",
      "@weekday",
      "@yearEnd",
      "geoDistance(",
      "strftime(",
      "true",
      "false",
      "null",
      '""',
    ]),
  );
  expect(list).not.toContain("pw");
  expect(list).not.toContain("hid");
  expect(list).not.toContain("author.secret");
  expect(list).not.toContain("author.pw");
  expect(list.filter((x) => x === "id")).toHaveLength(1);
});

test("only fields the collection has are offered, no phantom system fields", () => {
  const view: FilterSchema = {
    collectionId: "v",
    fields: [
      { name: "id", type: "text" },
      { name: "status", type: "text" },
      { name: "views", type: "number" },
    ],
  };
  const list = labels(view, "");
  expect(list).toEqual(expect.arrayContaining(["id", "status", "views"]));
  expect(list).not.toContain("created");
  expect(list).not.toContain("updated");
});

test("operand start also applies after logic operators and open parens", () => {
  for (const text of [
    "title = 1 && ",
    "title = 1 || ",
    "(",
    "(title = 1) && (",
  ])
    expect(labels(schema, text)).toContain("title");
});

test("the word being typed sets from", () => {
  expect(from(schema, "title = 1 && au")).toBe(13);
  expect(from(schema, "author.n")).toBe(0);
});

test("filters hide request params, rules offer them", () => {
  expect(labels(schema, "").some((l) => l.startsWith("@request"))).toBe(false);
  expect(labels(schema, "").some((l) => l.startsWith("@collection"))).toBe(
    false,
  );
  const list = labels(rules, "");
  expect(list).toEqual(
    expect.arrayContaining([
      "@request.method",
      "@request.context",
      "@request.query.",
      "@request.headers.",
      "@request.auth.id",
      "@request.auth.collectionId",
      "@request.auth.collectionName",
      "@request.auth.name",
      "@request.body.title",
      "@request.body.author",
      "@collection.users.",
      "@collection.comments.",
      "hid",
    ]),
  );
  expect(list).not.toContain("@request.auth.secret");
  expect(list).not.toContain("@request.auth.pw");
  expect(list).not.toContain("pw");
});

test("rules without a request body skip @request.body", () => {
  const list = labels({ ...schema, request: { body: false } }, "");
  expect(list.some((l) => l.startsWith("@request.body"))).toBe(false);
  expect(list).toContain("@request.auth.id");
});

test("@collection.<name>. offers that collection's fields", () => {
  const list = labels(rules, "@collection.comments.");
  expect(list).toContain("@collection.comments.body");
  expect(list).toContain("@collection.comments.id");
  expect(labels(rules, "@collection.users:u.")).toContain(
    "@collection.users:u.name",
  );
});

test("after a field offers operators and no values", () => {
  const list = labels(schema, "title ");
  expect(list).toEqual(
    expect.arrayContaining(["=", "!=", ">", ">=", "<", "<=", "~", "!~"]),
  );
  expect(list).toEqual(expect.arrayContaining(["?=", "?!=", "?>=", "?!~"]));
  expect(list).not.toContain("@now");
  expect(list).not.toContain("title");
});

test("a partial operator is replaced as a whole", () => {
  expect(from(schema, "title ?")).toBe(6);
  expect(labels(schema, "title !")).toContain("!=");
});

test("a colon after a field offers the modifiers the server accepts, from after the colon", () => {
  expect(from(schema, "title:")).toBe(6);
  expect(labels(schema, "title:")).toEqual(["lower"]);
  expect(labels(schema, "tags:").sort()).toEqual(["each", "length", "lower"]);
  expect(labels(schema, "files:").sort()).toEqual(["each", "length", "lower"]);
  expect(labels(schema, "author.name:")).toEqual(["lower"]);
});

test("request params only offer the modifiers the server accepts", () => {
  expect(labels(rules, "@request.query.x:").sort()).toEqual(["isset", "lower"]);
  expect(labels(rules, "@request.body.title:").sort()).toEqual([
    "changed",
    "isset",
    "lower",
  ]);
  expect(labels(rules, "@request.body.tags:").sort()).toEqual([
    "changed",
    "each",
    "isset",
    "length",
    "lower",
  ]);
  expect(labels(rules, "@request.auth.verified:").sort()).toEqual([
    "isset",
    "lower",
  ]);
  expect(labels(rules, "@request.auth.name:")).toEqual(["lower"]);
  expect(labels(rules, "@collection.comments.body:")).toEqual(["lower"]);
});

test("after an operator offers values", () => {
  const list = labels(schema, "title = ");
  expect(list).toEqual(
    expect.arrayContaining(["@now", "true", "null", "title", "author.name"]),
  );
  expect(list).not.toContain("&&");
  expect(labels(schema, "title ?~ n")).toContain("null");
});

test("after a complete expression offers && || and ) only inside parens", () => {
  expect(labels(schema, 'title = "a" ')).toEqual(["&&", "||"]);
  expect(labels(schema, "title = @now ")).toEqual(["&&", "||"]);
  expect(labels(schema, "(title = 1 ")).toEqual(["&&", "||", ")"]);
  expect(labels(schema, "(title = 1) ")).toEqual(["&&", "||"]);
  expect(from(schema, "title = 1 &")).toBe(10);
});

test("function arguments are operands and offer , and )", () => {
  expect(labels(schema, "geoDistance(")).toContain("title");
  expect(labels(schema, "geoDistance(a, ")).toContain("title");
  expect(labels(schema, "geoDistance(a ")).toEqual([",", ")"]);
  expect(labels(schema, "geoDistance(a, b, c, d) ")).toEqual(
    expect.arrayContaining(["=", ">"]),
  );
  expect(labels(schema, "strftime('%Y', created) = ")).toContain("@now");
});

test("inside a string nothing is suggested", () => {
  expect(createSuggest(schema)('title = "ab', 12)).toBeNull();
  expect(createSuggest(schema)("title ~ 'a b", 12)).toBeNull();
  expect(labels(schema, '"a" ')).toEqual(expect.arrayContaining(["="]));
});

test("a word after a complete operand is not completed", () => {
  expect(createSuggest(schema)("title = 1 ti", 12)).toBeNull();
});

test("completes at the cursor, not the end of the text", () => {
  expect(labels(schema, "au^ = 1")).toContain("author");
});

test("logs schema offers log fields only", () => {
  const list = labels(logsSchema, "");
  expect(list).toEqual(
    expect.arrayContaining([
      "id",
      "created",
      "level",
      "message",
      "data.status",
      "data.method",
      "data.url",
      "data.auth",
      "data.userIP",
      "data.execTime",
    ]),
  );
  expect(list).not.toContain("updated");
  expect(list.some((l) => l.startsWith("@request"))).toBe(false);
});

test("every option has a detail", () => {
  const result = createSuggest(rules)("", 0)!;
  expect(result.options.every((o) => o.detail)).toBe(true);
  expect(result.options.find((o) => o.label === "title")!.detail).toBe("text");
  expect(result.options.find((o) => o.label === "@now")!.detail).toBe("macro");
  expect(
    createSuggest(rules)("title ", 6)!.options.every(
      (o) => o.detail === "operator" || o.detail === "logic",
    ),
  ).toBe(true);
});
