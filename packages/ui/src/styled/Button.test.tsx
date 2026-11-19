import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Button } from "./Button.js";

test("primary Button has the accent classes and no gradient", () => {
  render(<Button variant="primary">Save</Button>);
  const cls = screen.getByRole("button").className;
  expect(cls).toContain("bg-accent");
  expect(cls).toContain("text-accent-fg");
  expect(cls).not.toContain("gradient");
  expect(cls).not.toContain("shadow");
});

test("Button size md is the default", () => {
  render(<Button>Save</Button>);
  expect(screen.getByRole("button").getAttribute("data-size")).toBe("md");
});

test("Button size sm is reflected in data-size", () => {
  render(<Button size="sm">Save</Button>);
  expect(screen.getByRole("button").getAttribute("data-size")).toBe("sm");
});

test("Button loading disables it and sets aria-busy", () => {
  render(<Button loading>Save</Button>);
  const button = screen.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
});

test("hover classes apply only to enabled buttons", () => {
  render(<Button variant="primary">Save</Button>);
  const cls = screen.getByRole("button").className;
  expect(cls).toContain("enabled:hover:bg-accent-hover");
  expect(cls.split(" ").filter((c) => c.startsWith("hover:"))).toEqual([]);
});
