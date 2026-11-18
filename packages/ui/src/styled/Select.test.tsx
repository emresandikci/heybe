import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Select } from "./Select.js";

test("Select renders the chevron and appearance-none", () => {
  render(
    <Select label="Type">
      <option>a</option>
    </Select>,
  );
  const select = screen.getByLabelText("Type");
  expect(select.className).toContain("appearance-none");
  expect(select.parentElement!.querySelector("svg")).not.toBeNull();
});
