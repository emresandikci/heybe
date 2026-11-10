import { expect, test } from "bun:test";
import { changedSections } from "./use-settings";

test("changedSections returns only changed top-level keys", () => {
  const before = { a: { x: 1 }, b: [1, 2], c: "same" };
  const after = { a: { x: 2 }, b: [1, 2], c: "same" };
  expect(changedSections(before, after)).toEqual({ a: { x: 2 } });
  expect(changedSections(before, before)).toEqual({});
});
