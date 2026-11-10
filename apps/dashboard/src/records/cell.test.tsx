import { expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { CellValue } from "./cell";

const cell = (type: string, value: unknown, extra: object = {}) =>
  render(
    <CellValue
      field={{ name: "f", type, ...extra }}
      value={value}
      record={{ id: "r1", f: value }}
    />,
  ).container;

test("text and json cut at 100 characters", () => {
  expect(cell("text", "x".repeat(300)).textContent).toBe("x".repeat(100));
  expect(cell("json", { a: "y".repeat(300) }).textContent).toHaveLength(100);
});

test("editor shows the text of the html", () => {
  const c = cell("editor", "<p>Hello <b>big</b> world</p><script>x()</script>");
  expect(c.textContent).toBe("Hello big worldx()");
  expect(c.querySelector("b, p, script")).toBeNull();
});

test("bool, select, geoPoint and password", () => {
  expect(cell("bool", true).textContent).toBe("Yes");
  expect(cell("bool", false).textContent).toBe("No");
  expect(cell("select", ["a", "b"]).textContent).toBe("a, b");
  expect(cell("select", "a").textContent).toBe("a");
  expect(cell("geoPoint", { lon: 1.5, lat: -2 }).textContent).toBe("1.5, -2");
  expect(cell("password", "secret").textContent).toBe("******");
});

test("date shows the UTC string with the local time in a title", () => {
  const c = cell("date", "2026-11-11 10:20:30.000Z");
  expect(c.textContent).toBe("2026-11-11 10:20:30.000Z");
  expect(c.querySelector("[title]")).not.toBeNull();
});

test("empty values render nothing", () => {
  expect(cell("text", "").textContent).toBe("");
  expect(cell("date", "").textContent).toBe("");
  expect(cell("number", null).textContent).toBe("");
});
