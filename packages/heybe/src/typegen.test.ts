import { afterEach, beforeEach, expect, test } from "bun:test";
import { type App } from "./app";
import { testApp } from "./test-app";
import { generateTypes, writeTypesSafely } from "./typegen";

const autodates = [
  { name: "created", type: "autodate", onCreate: true, onUpdate: false },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
] as any;

let app: App;
beforeEach(() => {
  app = testApp();
});
afterEach(() => app.close());

test("generates the augmentation for base and auth collections", async () => {
  const users = await app.collections.save({
    name: "fx_users",
    type: "auth",
    fields: [
      { name: "name", type: "text" },
      { name: "avatar", type: "file", maxSelect: 1 },
      ...autodates,
    ] as any,
  });
  await app.collections.save({
    name: "fx_posts",
    fields: [
      { name: "title", type: "text" },
      { name: "views", type: "number" },
      { name: "tags", type: "select", values: ["a", "b"], maxSelect: 2 },
      {
        name: "author",
        type: "relation",
        collectionId: users.id,
        maxSelect: 1,
      },
      { name: "body", type: "editor" },
      { name: "location", type: "geoPoint" },
      ...autodates,
    ],
  });

  const expected = await Bun.file(
    new URL("./typegen.fixture.ts", import.meta.url),
  ).text();
  const fixtures = app.collections
    .all()
    .filter((c) => c.name.startsWith("fx_"));
  expect(generateTypes(fixtures)).toBe(expected);
});

test("relation fields name their target collection", async () => {
  const target = await app.collections.save({
    name: "rel_target",
    fields: [{ name: "a", type: "text" }] as any,
  });
  const fields = [
    { name: "one", type: "relation", collectionId: target.id, maxSelect: 1 },
    { name: "many", type: "relation", collectionId: target.id, maxSelect: 3 },
  ] as any;
  await app.collections.save({ name: "rel_source", fields });
  const all = app.collections.all();
  const alone = generateTypes(all.filter((c) => c.name === "rel_source"));
  expect(alone).toContain("one: Relation;");
  expect(alone).toContain("many: Relation[];");
  const full = generateTypes(all.filter((c) => c.name.startsWith("rel_")));
  expect(full).toContain('one: Relation<"rel_target">;');
  expect(full).toContain('many: Relation<"rel_target">[];');
});

test("maps every field type", async () => {
  await app.collections.save({
    name: "all",
    fields: [
      { name: "a", type: "email" },
      { name: "b", type: "url" },
      { name: "c", type: "date" },
      { name: "d", type: "bool" },
      { name: "e", type: "json" },
      { name: "f", type: "select", values: ["x", "y"], maxSelect: 1 },
      { name: "g", type: "file", maxSelect: 3 },
      { name: "h", type: "file", maxSelect: 1 },
      { name: "i", type: "editor" },
      { name: "j", type: "geoPoint" },
    ] as any,
  });
  const out = generateTypes(app.collections.all());
  for (const line of [
    "a: string;",
    "b: string;",
    "c: string;",
    "d: boolean;",
    "e: unknown;",
    'f: "x" | "y";',
    "g: string[];",
    "h: string;",
    "i: string;",
    "j: { lon: number; lat: number };",
  ])
    expect(out).toContain(line);
  expect(out).not.toContain("_superusers");
});

test("the store notifies after save and delete", async () => {
  let calls = 0;
  app.collections.onChange = () => calls++;
  await app.collections.save({
    name: "tmp",
    fields: [{ name: "a", type: "text" }] as any,
  });
  await app.collections.delete("tmp");
  expect(calls).toBe(2);
});

test("a failed write is only a warning", () => {
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => warnings.push(args);
  try {
    expect(() =>
      writeTypesSafely(app, "/nonexistent-dir/heybe-env.d.ts"),
    ).not.toThrow();
  } finally {
    console.warn = warn;
  }
  expect(warnings).toHaveLength(1);
});

test("includes view collections with their inferred fields", async () => {
  await app.collections.save({
    name: "posts",
    fields: [{ name: "title", type: "text" }] as any,
  });
  await app.collections.save({
    name: "post_stats",
    type: "view",
    viewQuery: "select id, title, count(id) as total from posts group by id",
  });
  expect(generateTypes(app.collections.all())).toContain(
    "    post_stats: {\n      id: string;\n      title: string;\n      total: number;\n    };",
  );
});
