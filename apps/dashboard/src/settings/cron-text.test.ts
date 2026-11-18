import { expect, test } from "bun:test";
import { describeCron } from "./cron-text";

test.each([
  ["* * * * *", "every minute"],
  ["*/15 * * * *", "every 15 minutes"],
  ["0 * * * *", "every hour"],
  ["0 */6 * * *", "every 6 hours"],
  ["0 0 * * *", "daily at 00:00"],
  ["30 4 * * *", "daily at 04:30"],
  ["0 0 * * 0", "weekly on Sunday at 00:00"],
  ["0 9 * * 1", "weekly on Monday at 09:00"],
  ["0 0 1 * *", null],
  ["nonsense", null],
])("describes %s", (expression, expected) => {
  expect(describeCron(expression)).toBe(expected);
});
