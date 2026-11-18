import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./Switch.js";

test("Switch toggles aria-checked on click and Space", async () => {
  const user = userEvent.setup({ delay: null });
  const calls: boolean[] = [];
  render(
    <Switch label="Enabled" onChange={(checked) => calls.push(checked)} />,
  );
  const toggle = screen.getByRole("switch", { name: "Enabled" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await user.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  toggle.focus();
  await user.keyboard(" ");
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(calls).toEqual([true, false]);
});

test("Switch does not toggle when disabled", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Switch label="Enabled" disabled />);
  await user.click(screen.getByRole("switch"));
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
});

test("Switch toggles on Enter", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Switch label="Enabled" />);
  screen.getByRole("switch").focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
});
