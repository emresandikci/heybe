import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RadioGroup } from "./RadioGroup.js";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

function Host(props: { error?: string; hint?: string }) {
  const [value, setValue] = useState("a");
  return (
    <RadioGroup
      label="Letter"
      options={options}
      value={value}
      onChange={setValue}
      {...props}
    />
  );
}

test("RadioGroup is labelled and selects an option", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Host />);
  expect(screen.getByRole("radiogroup", { name: "Letter" })).toBeTruthy();
  await user.click(screen.getByRole("radio", { name: "Beta" }));
  expect(
    screen.getByRole("radio", { name: "Beta" }).getAttribute("aria-checked"),
  ).toBe("true");
});

test("RadioGroup links hint and error and sets aria-invalid", () => {
  render(<Host error="Pick one." hint="Any." />);
  const group = screen.getByRole("radiogroup");
  expect(group.getAttribute("aria-invalid")).toBe("true");
  const texts = group
    .getAttribute("aria-describedby")!
    .split(" ")
    .map((id) => document.getElementById(id)!.textContent);
  expect(texts).toEqual(["Any.", "Pick one."]);
});

test("RadioGroup styles the radio ring as danger only when invalid", () => {
  render(<Host error="Pick one." />);
  expect(screen.getByRole("radiogroup").className).toContain(
    "aria-[invalid=true]:[&>button]:before:border-danger",
  );
});
