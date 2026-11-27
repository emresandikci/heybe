import { describe, expect, test } from "bun:test";
import type { CollectionModel } from "@heybejs/client";
import { collectionsFixture, scaffoldsFixture } from "../test/fixtures";
import {
  addField,
  diffCollection,
  draftFrom,
  duplicateDraft,
  hasChanges,
  moveField,
  newDraft,
  removeField,
  renameCollection,
  renameField,
  restoreField,
  setIndexes,
  finalIndexes,
  toPayload,
} from "./editor-state";

const posts = collectionsFixture.find((c) => c.name === "posts")!;
const withIndexes = (indexes: string[]): CollectionModel => ({
  ...posts,
  indexes,
});
const keyOf = (d: ReturnType<typeof draftFrom>, name: string) =>
  d.fields.find((f) => f.name === name)!._key;

describe("editor-state", () => {
  test("renameField keeps the id and rewrites index columns", () => {
    const d = draftFrom(
      withIndexes([
        "CREATE INDEX `idx_a` ON `posts` (`title`)",
        "CREATE UNIQUE INDEX `idx_b` ON `posts` (`views`, title) WHERE `title` != 'title'",
      ]),
    );
    let next = renameField(d, keyOf(d, "title"), "");
    next = renameField(next, keyOf(d, "title"), "headline");
    const field = next.fields.find((f) => f._key === keyOf(d, "title"))!;
    expect(field.name).toBe("headline");
    expect(field.id).toBe("text_title");
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`headline`)",
      "CREATE UNIQUE INDEX `idx_b` ON `posts` (`views`, `headline`) WHERE `headline` != 'title'",
    ]);
    expect(d.fields.find((f) => f.name === "title")).toBeTruthy();
  });

  test("index renames do not collide with prefixes of other field names", () => {
    const d = draftFrom({
      ...withIndexes([
        "CREATE INDEX `idx_a` ON `posts` (`views`, `published`)",
      ]),
      fields: [
        ...posts.fields,
        { id: "text_v", name: "v", type: "text" },
        { id: "text_vi", name: "vi", type: "text" },
      ],
    });
    let next = renameField(d, keyOf(d, "views"), "vi");
    next = renameField(next, keyOf(d, "vi"), "vie");
    next = renameField(next, keyOf(d, "views"), "views2");
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`views2`, `published`)",
    ]);
  });

  test("swapping two field names swaps them in indexes", () => {
    const d = draftFrom(
      withIndexes(["CREATE INDEX `idx_a` ON `posts` (`title`, `views`)"]),
    );
    let next = renameField(d, keyOf(d, "title"), "tmp");
    next = renameField(next, keyOf(d, "views"), "title");
    next = renameField(next, keyOf(d, "title"), "views");
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`views`, `title`)",
    ]);
  });

  test("index renames match case-insensitively and skip function names and strings", () => {
    const d = draftFrom({
      ...withIndexes([
        "CREATE INDEX `idx_a` ON `posts` (lower(TITLE)) WHERE `Title` != 'title' AND lower (views) > 0",
      ]),
      fields: [
        ...posts.fields,
        { id: "text_lower", name: "lower", type: "text" },
      ],
    });
    let next = renameField(d, keyOf(d, "title"), "headline");
    next = renameField(next, keyOf(d, "lower"), "small");
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (lower(`headline`)) WHERE `headline` != 'title' AND lower (views) > 0",
    ]);
  });

  test("renameCollection rewrites ON clauses only", () => {
    const d = draftFrom(
      withIndexes(["CREATE INDEX `idx_posts` ON `posts` (`posts`)"]),
    );
    expect(toPayload(renameCollection(d, "articles")).indexes).toEqual([
      "CREATE INDEX `idx_posts` ON `articles` (`posts`)",
    ]);
    const fresh = renameCollection(
      newDraft("auth", scaffoldsFixture),
      "members",
    );
    expect(fresh.name).toBe("members");
    expect(toPayload(fresh).indexes![0]).toBe(
      "CREATE UNIQUE INDEX `idx_tokenKey_abc` ON `members` (`tokenKey`)",
    );
  });

  test("toPayload drops _key and keeps ids only on existing fields", () => {
    const d = addField(draftFrom(posts), "text");
    const payload = toPayload(d);
    expect(payload).not.toHaveProperty("created");
    expect(payload).not.toHaveProperty("updated");
    const fields = payload.fields!;
    expect(fields.every((f) => !("_key" in f))).toBe(true);
    expect(fields.slice(0, -1).every((f) => typeof f.id === "string")).toBe(
      true,
    );
    expect(fields.at(-1)).toMatchObject({ name: "field", type: "text" });
    expect(fields.at(-1)).not.toHaveProperty("id");
    expect(toPayload(newDraft("base", scaffoldsFixture))).not.toHaveProperty(
      "id",
    );
  });

  test("addField picks a unique name", () => {
    let d = addField(draftFrom(posts), "bool");
    d = addField(d, "bool");
    expect(d.fields.slice(-2).map((f) => f.name)).toEqual(["field", "field2"]);
  });

  test("removeField marks existing fields, drops new ones and keeps system fields", () => {
    const d = addField(draftFrom(posts), "text");
    const removed = removeField(
      removeField(d, keyOf(d, "views")),
      keyOf(d, "field"),
    );
    expect(removed.fields.find((f) => f.name === "field")).toBeUndefined();
    expect(toPayload(removed).fields!.map((f) => f.name)).not.toContain(
      "views",
    );
    expect(
      toPayload(restoreField(removed, keyOf(d, "views"))).fields!.map(
        (f) => f.name,
      ),
    ).toContain("views");
    expect(removeField(d, keyOf(d, "id"))).toEqual(d);
  });

  test("moveField swaps neighbours and stops at the ends", () => {
    const d = draftFrom(posts);
    const moved = moveField(d, keyOf(d, "views"), -1);
    expect(moved.fields.slice(1, 3).map((f) => f.name)).toEqual([
      "views",
      "title",
    ]);
    expect(moveField(d, keyOf(d, "id"), -1)).toEqual(d);
  });

  test("diffCollection lists deleted and renamed fields, the renamed collection and changed rules", () => {
    const d = draftFrom(posts);
    let next = renameCollection(d, "articles");
    next = renameField(next, keyOf(d, "title"), "headline");
    next = removeField(next, keyOf(d, "views"));
    next = addField(next, "text");
    next = { ...next, listRule: "" };
    const changes = diffCollection(posts, next);
    expect(changes).toEqual({
      renamedCollection: ["posts", "articles"],
      deletedFields: ["views"],
      renamedFields: [["title", "headline"]],
      changedRules: ["listRule"],
    });
    expect(hasChanges(changes)).toBe(true);
    expect(hasChanges(diffCollection(posts, draftFrom(posts)))).toBe(false);
  });

  test("duplicateDraft renames the copy and drops ids", () => {
    const d = duplicateDraft(
      withIndexes(["CREATE INDEX `idx_a` ON `posts` (`title`)"]),
    );
    expect(d.name).toBe("posts_duplicate");
    expect(toPayload(d)).not.toHaveProperty("id");
    expect(d.fields.every((f) => f.id === undefined)).toBe(true);
    expect(toPayload(d).indexes![0]).toMatch(
      /^CREATE INDEX `idx_[a-zA-Z0-9]{10}` ON `posts_duplicate` \(`title`\)$/,
    );
  });

  test("indexes edited after a rename are kept in current names and still follow later renames", () => {
    const d = draftFrom(
      withIndexes(["CREATE INDEX `idx_a` ON `posts` (`title`)"]),
    );
    let next = renameField(d, keyOf(d, "title"), "headline");
    next = renameField(next, keyOf(d, "views"), "title");
    expect(finalIndexes(next)).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`headline`)",
    ]);
    next = setIndexes(next, [
      ...finalIndexes(next),
      "CREATE INDEX `idx_b` ON `posts` (`title`)",
    ]);
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`headline`)",
      "CREATE INDEX `idx_b` ON `posts` (`title`)",
    ]);
    next = renameField(next, keyOf(d, "title"), "heading");
    next = renameCollection(next, "articles");
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `articles` (`heading`)",
      "CREATE INDEX `idx_b` ON `articles` (`title`)",
    ]);
  });

  test("setIndexes keeps a removed renamed field mapped for restore", () => {
    const d = draftFrom(
      withIndexes(["CREATE INDEX `idx_a` ON `posts` (`views`)"]),
    );
    let next = renameField(d, keyOf(d, "views"), "hits");
    next = removeField(next, keyOf(d, "views"));
    next = setIndexes(next, finalIndexes(next));
    next = restoreField(next, keyOf(d, "views"));
    expect(toPayload(next).indexes).toEqual([
      "CREATE INDEX `idx_a` ON `posts` (`hits`)",
    ]);
  });

  test("restoring a renamed field does not rewrite indexes that now use its old name", () => {
    let d = draftFrom(withIndexes(["CREATE INDEX `i1` ON `posts` (`title`)"]));
    const title = keyOf(d, "title");
    d = renameField(d, title, "headline");
    d = removeField(d, title);
    d = renameField(d, keyOf(d, "views"), "title");
    d = setIndexes(d, [
      ...finalIndexes(d),
      "CREATE INDEX `i2` ON `posts` (`title`)",
    ]);
    d = restoreField(d, title);
    expect(toPayload(d).indexes).toEqual([
      "CREATE INDEX `i1` ON `posts` (`headline`)",
      "CREATE INDEX `i2` ON `posts` (`title`)",
    ]);
  });

  test("renaming the collection back after an index edit rewrites ON", () => {
    let d = draftFrom(withIndexes(["CREATE INDEX `i1` ON `posts` (`title`)"]));
    d = renameCollection(d, "articles");
    d = setIndexes(d, finalIndexes(d));
    d = renameCollection(d, "posts");
    expect(toPayload(d).indexes).toEqual([
      "CREATE INDEX `i1` ON `posts` (`title`)",
    ]);
  });

  test("view payloads leave out fields", () => {
    const stats = collectionsFixture.find((c) => c.name === "stats")!;
    const payload = toPayload({ ...draftFrom(stats), viewQuery: "SELECT 1" });
    expect(payload).not.toHaveProperty("fields");
    expect(payload.viewQuery).toBe("SELECT 1");
  });

  test("new select, relation and file fields start single and autodate on create", () => {
    let d = draftFrom(posts);
    for (const type of ["select", "relation", "file", "autodate"] as const)
      d = addField(d, type);
    expect(d.fields.slice(-4).map((f) => [f.maxSelect, f.onCreate])).toEqual([
      [1, undefined],
      [1, undefined],
      [1, undefined],
      [undefined, true],
    ]);
  });
});
