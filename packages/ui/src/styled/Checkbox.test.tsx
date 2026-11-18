import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./Checkbox.js";

test("Checkbox toggles by label and restores the native look in forced colors", async () => {
  render(<Checkbox label="Enabled" />);
  const box = screen.getByLabelText("Enabled") as HTMLInputElement;
  await userEvent.setup({ delay: null }).click(screen.getByText("Enabled"));
  expect(box.checked).toBe(true);
  expect(box.className).toContain("border-field-line");
  expect(box.className).toContain("forced-colors:appearance-auto");
});
