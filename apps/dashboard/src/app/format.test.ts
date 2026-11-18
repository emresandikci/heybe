import { expect, test } from "bun:test";
import { formatDate } from "./format";

const date = new Date(2026, 10, 18, 13, 17, 9);

test("formatDate short and full", () => {
  expect(formatDate(date)).toMatch(/^Nov 18, 2026, 1:17\sPM$/);
  expect(formatDate(date, "short")).toBe(formatDate(date));
  expect(formatDate(date, "full")).toMatch(
    /^Nov 18, 2026, 1:17:09\sPM GMT([+-]\d+(:\d+)?)?$/,
  );
  expect(formatDate(date.toISOString(), "short")).toBe(formatDate(date));
});

test("formatDate leaves an unparseable value as it is", () => {
  expect(formatDate("not a date")).toBe("not a date");
});

test("formatDate accepts the space separated server form", () => {
  expect(formatDate("2026-11-18 13:17:00.000Z")).toBe(
    formatDate(new Date("2026-11-18T13:17:00.000Z")),
  );
});
