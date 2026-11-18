import { expect, test } from "bun:test";
import { mergeProps } from "./mergeProps.js";

test("mergeProps chains onClick handlers in order and joins className", () => {
  const calls: number[] = [];
  const merged = mergeProps(
    { onClick: () => calls.push(1), className: "one" },
    { onClick: () => calls.push(2), className: "two" },
  );
  (merged.onClick as () => void)();
  expect(calls).toEqual([1, 2]);
  expect(merged.className).toBe("one two");
});
