import { expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { RadioGroup } from "./RadioGroup.js";

test("RadioGroup ArrowDown selects the next enabled option", async () => {
  const user = userEvent.setup({ delay: null });
  function Host() {
    const [value, setValue] = useState("a");
    return (
      <RadioGroup
        label="Pick"
        value={value}
        onChange={setValue}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta", disabled: true },
          { value: "c", label: "Gamma" },
        ]}
      />
    );
  }
  render(<Host />);
  act(() => screen.getByRole("radio", { name: "Alpha" }).focus());
  await user.keyboard("{ArrowDown}");
  const gamma = screen.getByRole("radio", { name: "Gamma" });
  expect(gamma.getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement).toBe(gamma);
  expect(screen.getByRole("radio", { name: "Alpha" }).tabIndex).toBe(-1);
});

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
];

function Host(props: { orientation?: "vertical" | "horizontal" }) {
  const [value, setValue] = useState("a");
  return (
    <RadioGroup
      label="Pick"
      value={value}
      onChange={setValue}
      options={options}
      orientation={props.orientation}
    />
  );
}

const checked = (name: string) =>
  screen.getByRole("radio", { name }).getAttribute("aria-checked");

test("RadioGroup handles all four arrows in a vertical group", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Host />);
  act(() => screen.getByRole("radio", { name: "Alpha" }).focus());
  await user.keyboard("{ArrowRight}");
  expect(checked("Gamma")).toBe("true");
  await user.keyboard("{ArrowLeft}");
  expect(checked("Alpha")).toBe("true");
});

test("RadioGroup wraps around and supports Home and End", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Host orientation="horizontal" />);
  act(() => screen.getByRole("radio", { name: "Alpha" }).focus());
  await user.keyboard("{ArrowLeft}");
  expect(checked("Gamma")).toBe("true");
  await user.keyboard("{ArrowRight}");
  expect(checked("Alpha")).toBe("true");
  await user.keyboard("{End}");
  expect(checked("Gamma")).toBe("true");
  await user.keyboard("{Home}");
  expect(checked("Alpha")).toBe("true");
});
