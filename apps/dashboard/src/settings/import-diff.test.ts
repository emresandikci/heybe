import { expect, test } from "bun:test";
import { collectionsFixture } from "../test/fixtures";
import { diffImport, exportJson, parseImport } from "./import-diff";

const exported = () =>
  JSON.parse(exportJson(collectionsFixture)) as Record<string, unknown>[];
const posts = collectionsFixture.find((c) => c.name === "posts")!;

test("diffImport of an unchanged export is empty", () => {
  expect(diffImport(collectionsFixture, exported(), true)).toEqual({
    added: [],
    changed: [],
    deleted: [],
  });
});

test("diffImport matches by id first, then by name", () => {
  const renamed = { ...posts, name: "articles" };
  const byName = { ...exported().find((c) => c.name === "stats"), id: "" };
  const fresh = { name: "tags", type: "base", fields: [] };
  const diff = diffImport(
    collectionsFixture,
    [renamed, byName, fresh] as never,
    false,
  );
  expect(diff.added).toEqual(["tags"]);
  expect(diff.changed).toEqual([
    {
      name: "articles",
      previousName: "posts",
      fields: { added: [], changed: [], deleted: [] },
    },
  ]);
  expect(diff.deleted).toEqual([]);
});

test("diffImport ignores created and updated", () => {
  const list = exported().map((c) => ({
    ...c,
    created: "2030-01-01 00:00:00.000Z",
    updated: "2030-01-01 00:00:00.000Z",
  }));
  expect(diffImport(collectionsFixture, list, false).changed).toEqual([]);
});

test("diffImport lists added, changed and deleted fields", () => {
  const fields = posts.fields
    .filter((f) => f.name !== "views")
    .map((f) =>
      f.name === "title"
        ? { ...f, required: false }
        : f.name === "site"
          ? { ...f, name: "website" }
          : f,
    );
  const incoming = {
    ...posts,
    fields: [...fields, { name: "slug", type: "text" }],
  };
  expect(diffImport([posts], [incoming], true).changed).toEqual([
    {
      name: "posts",
      fields: {
        added: ["slug"],
        changed: ["title", "site -> website"],
        deleted: ["views"],
      },
    },
  ]);
  expect(diffImport([posts], [incoming], false).changed[0]!.fields).toEqual({
    added: ["slug"],
    changed: ["title", "site -> website"],
    deleted: [],
  });
});

test("fields without id match by name and type like the server", () => {
  const fields = posts.fields.map(({ id: _, ...f }) =>
    f.name === "views" ? { ...f, type: "text" } : f,
  );
  expect(
    diffImport([posts], [{ ...posts, fields }], false).changed[0]!.fields,
  ).toEqual({ added: ["views"], changed: [], deleted: [] });

  const names = posts.fields
    .filter((f) => !f.system)
    .map((f) => String(f.name));
  expect(
    diffImport([posts], [{ ...posts, fields }], true).changed[0]!.fields,
  ).toEqual({ added: names, changed: [], deleted: names });
});

test("missing fields are deleted with deleteMissing, system fields never", () => {
  const users = collectionsFixture.find((c) => c.name === "users")!;
  const { fields: _, ...withoutFields } = users;
  const diff = diffImport([users], [withoutFields], true);
  expect(diff.changed[0]!.fields.deleted).toEqual([
    "name",
    "username",
    "avatar",
    "created",
    "updated",
  ]);
  expect(diffImport([users], [withoutFields], false).changed).toEqual([]);
});

test("system collections are never in deleted", () => {
  expect(diffImport(collectionsFixture, [posts], true).deleted).toEqual([
    "stats",
    "users",
  ]);
  expect(diffImport(collectionsFixture, [posts], false).deleted).toEqual([]);
});

test("parseImport rejects non-array JSON and items without name", () => {
  expect(() => parseImport("{")).toThrow(/^Invalid collections JSON: .+\.$/);
  expect(() => parseImport('{"name":"a"}')).toThrow(
    "Invalid collections JSON: expected an array.",
  );
  expect(() => parseImport('[{"name":"a"},{"type":"base"}]')).toThrow(
    "Invalid collections JSON: item 2 has no name.",
  );
  expect(() => parseImport("[1]")).toThrow(
    "Invalid collections JSON: item 1 has no name.",
  );
  expect(parseImport('[{"name":"a"}]')).toEqual([{ name: "a" }]);
});

test("export JSON has no created or updated", () => {
  const text = exportJson([posts]);
  const [item] = JSON.parse(text) as Record<string, unknown>[];
  expect(item!.created).toBeUndefined();
  expect(item!.updated).toBeUndefined();
  expect(item!.name).toBe("posts");
  expect(text.startsWith('[\n  {\n    "')).toBe(true);
});
