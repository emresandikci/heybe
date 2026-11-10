import { expect, test } from "bun:test";
import { collectionsFixture } from "../../test/fixtures";
import { draftFrom, removeField } from "../editor-state";
import { ruleChips } from "./rule-chips";

const posts = collectionsFixture.find((c) => c.name === "posts")!;

test("create rule chips include @request.body.title, list rule chips do not", () => {
  const d = draftFrom(posts);
  const create = ruleChips(d, collectionsFixture, "createRule");
  const list = ruleChips(d, collectionsFixture, "listRule");
  expect(create).toContain("@request.body.title");
  expect(ruleChips(d, collectionsFixture, "updateRule")).toContain(
    "@request.body.title",
  );
  expect(list.some((c) => c.startsWith("@request.body."))).toBe(false);
  for (const chip of [
    "title",
    "@request.auth.id",
    "@request.auth.collectionName",
    "@request.query.",
    "@request.headers.",
    "@now",
    "@todayStart",
    "@todayEnd",
    "@monthStart",
    "@monthEnd",
    "@yearStart",
    "@yearEnd",
  ])
    expect(list).toContain(chip);
});

test("@collection chips list the other collections", () => {
  const chips = ruleChips(draftFrom(posts), collectionsFixture, "viewRule");
  expect(chips.filter((c) => c.startsWith("@collection."))).toEqual([
    "@collection.stats.",
    "@collection._superusers.",
    "@collection.users.",
  ]);
});

test("removed fields are not offered", () => {
  const d = draftFrom(posts);
  const key = d.fields.find((f) => f.name === "views")!._key;
  expect(ruleChips(removeField(d, key), [], "listRule")).not.toContain("views");
});
