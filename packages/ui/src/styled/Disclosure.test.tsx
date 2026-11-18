import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Badge } from "./Badge.js";
import { Disclosure } from "./Disclosure.js";

test("Disclosure toggles aria-expanded and shows the body", async () => {
  const u = userEvent.setup({ delay: null });
  render(
    <Disclosure
      title="Custom endpoints"
      badge={<Badge tone="neutral">2</Badge>}
    >
      <p>Body text</p>
    </Disclosure>,
  );
  const button = screen.getByRole("button", { name: /Custom endpoints/ });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  const body = screen.getByText("Body text").parentElement!;
  expect(body.hidden).toBe(true);
  expect(button.getAttribute("aria-controls")).toBe(body.id);
  button.focus();
  await u.keyboard("{Enter}");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(body.hidden).toBe(false);
});

test("Disclosure defaultOpen starts expanded", () => {
  render(
    <Disclosure title="T" defaultOpen>
      x
    </Disclosure>,
  );
  expect(
    screen.getByRole("button", { name: "T" }).getAttribute("aria-expanded"),
  ).toBe("true");
});

test("Disclosure controlled mode follows open and reports changes", async () => {
  const u = userEvent.setup({ delay: null });
  const changes: boolean[] = [];
  const { rerender } = render(
    <Disclosure title="T" open={false} onOpenChange={(o) => changes.push(o)}>
      x
    </Disclosure>,
  );
  const button = screen.getByRole("button", { name: "T" });
  await u.click(button);
  expect(changes).toEqual([true]);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  rerender(
    <Disclosure title="T" open onOpenChange={(o) => changes.push(o)}>
      x
    </Disclosure>,
  );
  expect(button.getAttribute("aria-expanded")).toBe("true");
});

test("Disclosure renders a zero badge", () => {
  render(
    <Disclosure title="T" badge={<Badge tone="neutral">0</Badge>}>
      x
    </Disclosure>,
  );
  expect(screen.getByText("0")).toBeTruthy();
});

test("Badge renders tone classes", () => {
  render(
    <>
      <Badge tone="success">ok</Badge>
      <Badge tone="danger">bad</Badge>
      <Badge tone="warning">warn</Badge>
      <Badge tone="neutral">none</Badge>
    </>,
  );
  expect(screen.getByText("ok").className).toContain("text-success-text");
  expect(screen.getByText("bad").className).toContain("text-danger-text");
  expect(screen.getByText("warn").className).toContain("text-warning-text");
  expect(screen.getByText("none").className).toContain("text-muted");
});
