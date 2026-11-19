import { expect, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Tabs, tabPanelIds } from "./Tabs.js";

test("Tabs move with ArrowRight and ArrowLeft", async () => {
  const user = userEvent.setup({ delay: null });
  function Host() {
    const [value, setValue] = useState("a");
    return (
      <Tabs
        label="Sections"
        value={value}
        onChange={setValue}
        tabs={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
        ]}
      />
    );
  }
  render(<Host />);
  const alpha = screen.getByRole("tab", { name: "Alpha" });
  act(() => alpha.focus());
  await user.keyboard("{ArrowRight}");
  const beta = screen.getByRole("tab", { name: "Beta" });
  expect(beta.getAttribute("aria-selected")).toBe("true");
  expect(beta.tabIndex).toBe(0);
  expect(alpha.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(beta);
  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(
    screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected"),
  ).toBe("true");
});

const tabs = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

function Controlled(props: { onChange?(v: string): void; id?: string }) {
  const [value, setValue] = useState("a");
  return (
    <>
      <button>Before</button>
      <Tabs
        id={props.id}
        label="Sections"
        value={value}
        onChange={(v) => {
          props.onChange?.(v);
          setValue(v);
        }}
        tabs={tabs}
      />
    </>
  );
}

test("Tabs click calls onChange once and Tab focus does not select", async () => {
  const user = userEvent.setup({ delay: null });
  const calls: string[] = [];
  render(<Controlled onChange={(v) => calls.push(v)} />);
  await user.click(screen.getByRole("tab", { name: "Beta" }));
  expect(calls).toEqual(["b"]);
  act(() => screen.getByRole("button", { name: "Before" }).focus());
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "Beta" }),
  );
  act(() => screen.getByRole("tab", { name: "Alpha" }).focus());
  expect(calls).toEqual(["b"]);
});

test("Tabs Home and End select the first and last tab", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Controlled />);
  act(() => screen.getByRole("tab", { name: "Alpha" }).focus());
  await user.keyboard("{End}");
  expect(
    screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected"),
  ).toBe("true");
  await user.keyboard("{Home}");
  expect(
    screen.getByRole("tab", { name: "Alpha" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("Tabs aria-controls matches the documented panel id", () => {
  render(<Controlled id="t" />);
  const tab = screen.getByRole("tab", { name: "Beta" });
  expect(tab.id).toBe(tabPanelIds("t", "b").tab);
  expect(tab.getAttribute("aria-controls")).toBe(tabPanelIds("t", "b").panel);
});

test("Tabs renders an empty list without throwing and ignores arrows", async () => {
  const user = userEvent.setup({ delay: null });
  render(<Tabs label="Sections" value="" onChange={() => {}} tabs={[]} />);
  const list = screen.getByRole("tablist");
  act(() => list.focus());
  await user.keyboard("{ArrowRight}{ArrowLeft}{Home}{End}");
  expect(list.children.length).toBe(0);
});

test("Tabs skip a disabled tab when moving with arrows", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange: string[] = [];
  render(
    <Tabs
      label="Sections"
      value="a"
      onChange={(v) => onChange.push(v)}
      tabs={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta", disabled: true },
        { value: "c", label: "Gamma" },
      ]}
    />,
  );
  const beta = screen.getByRole("tab", { name: "Beta" }) as HTMLButtonElement;
  expect(beta.disabled).toBe(true);
  act(() => screen.getByRole("tab", { name: "Alpha" }).focus());
  await user.keyboard("{ArrowRight}");
  expect(onChange).toEqual(["c"]);
});

test("Tabs gives the first enabled tab the tab stop when the selected tab is disabled", () => {
  render(
    <Tabs
      label="Sections"
      value="a"
      onChange={() => {}}
      tabs={[
        { value: "a", label: "Alpha", disabled: true },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma" },
      ]}
    />,
  );
  const stops = screen
    .getAllByRole("tab")
    .filter((tab) => (tab as HTMLButtonElement).tabIndex === 0)
    .map((tab) => tab.textContent);
  expect(stops).toEqual(["Beta"]);
});
