import { afterEach, beforeEach, expect, test } from "bun:test";
import { type App, createApp } from "./app";
import { generateTypes, writeTypesSafely } from "./typegen";

const autodates = [
  { name: "created", type: "autodate", onCreate: true, onUpdate: false },
  { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
] as any;

let app: App;
beforeEach(() => {
  app = createApp({ dir: ":memory:" });
});
afterEach(() => app.close());

test("generates the augmentation for base and auth collections", async () => {
  const users = app.collections.save({
    name: "fx_users",
    type: "auth",
    fields: [
      { name: "name", type: "text" },
      { name: "avatar", type: "file", maxSelect: 1 },
      ...autodates,
    ] as any,
  });
  app.collections.save({
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

test("maps every field type", () => {
  app.collections.save({
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
  ])
    expect(out).toContain(line);
  expect(out).not.toContain("_superusers");
});

test("the store notifies after save and delete", () => {
  let calls = 0;
  app.collections.onChange = () => calls++;
  app.collections.save({
    name: "tmp",
    fields: [{ name: "a", type: "text" }] as any,
  });
  app.collections.delete("tmp");
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
