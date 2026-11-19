import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, mock, test } from "bun:test";
import { useState } from "react";
import { Combobox } from "./Combobox.js";
import { Dialog } from "./Dialog.js";

const options = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Charlie", disabled: true },
];
const gapped = [
  { key: "a", label: "Alpha" },
  { key: "x", label: "Xray", disabled: true },
  { key: "b", label: "Beta" },
];
const originalScrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function Stateful(props: {
  initial?: string | null;
  onChange?(key: string | null): void;
  options?: typeof options;
}) {
  const [value, setValue] = useState<string | null>(props.initial ?? null);
  return (
    <Combobox
      label="Fruit"
      options={props.options ?? options}
      value={value}
      onChange={(key) => {
        setValue(key);
        props.onChange?.(key);
      }}
    />
  );
}

test("typing filters the options", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  await user.type(screen.getByRole("combobox"), "bet");
  expect(screen.getByRole("option", { name: "Beta" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Alpha" })).toBeNull();
});

test("ArrowDown and Enter select an option and call onChange", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock((_key: string | null) => {});
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={onChange}
    />,
  );
  const input = screen.getByRole("combobox");
  await user.click(input);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith("a");
});

test("Escape closes the list, a second Escape clears the input", async () => {
  const user = userEvent.setup({ delay: null });
  const onInputChange = mock((_text: string) => {});
  function Controlled() {
    const [text, setText] = useState("");
    return (
      <Combobox
        label="Fruit"
        options={options}
        value={null}
        onChange={() => {}}
        inputValue={text}
        onInputChange={(next) => {
          setText(next);
          onInputChange(next);
        }}
      />
    );
  }
  render(<Controlled />);
  const input = screen.getByRole("combobox");
  await user.type(input, "alpha");
  await user.keyboard("{ArrowDown}{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect((input as HTMLInputElement).value).toBe("alpha");
  await user.keyboard("{Escape}");
  expect((input as HTMLInputElement).value).toBe("");
  expect(onInputChange).toHaveBeenLastCalledWith("");
});

test("aria-activedescendant follows the active option", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole("combobox");
  await user.click(input);
  await user.keyboard("{ArrowDown}");
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "Alpha" }).id,
  );
});

test("active option is scrolled into view", async () => {
  const user = userEvent.setup({ delay: null });
  const scrollIntoView = mock(() => {});
  Element.prototype.scrollIntoView = scrollIntoView;
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  await user.keyboard("{ArrowDown}");
  expect(scrollIntoView).toHaveBeenCalled();
});

test("disabled options are skipped", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={gapped}
      value={null}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole("combobox");
  await user.click(input);
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "Beta" }).id,
  );
  expect(
    screen.getByRole("option", { name: "Xray" }).getAttribute("aria-disabled"),
  ).toBe("true");
});

test("ArrowUp moves to the previous option", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={gapped}
      value={null}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole("combobox");
  await user.click(input);
  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
  expect(input.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: "Alpha" }).id,
  );
});

test("clearing the text calls onChange(null) and stays cleared", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock((_key: string | null) => {});
  render(<Stateful initial="a" onChange={onChange} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  expect(input.value).toBe("Alpha");
  await user.clear(input);
  expect(onChange).toHaveBeenLastCalledWith(null);
  await user.keyboard("{Escape}");
  expect(input.value).toBe("");
});

test("two Escapes clear the selection", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock((_key: string | null) => {});
  render(<Stateful initial="a" onChange={onChange} />);
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await user.click(input);
  await user.keyboard("{Escape}{Escape}");
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(input.value).toBe("");
});

test("outside click closes the list", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <>
      <Combobox
        label="Fruit"
        options={options}
        value={null}
        onChange={() => {}}
      />
      <p>outside</p>
    </>,
  );
  await user.click(screen.getByRole("combobox"));
  expect(screen.getByRole("listbox")).toBeTruthy();
  await user.click(screen.getByText("outside"));
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("clicking an option selects it and closes", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock((_key: string | null) => {});
  render(<Stateful onChange={onChange} />);
  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("option", { name: "Beta" }));
  expect(onChange).toHaveBeenCalledWith("b");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Beta");
});

test("clicking a disabled option does nothing", async () => {
  const user = userEvent.setup({ delay: null });
  const onChange = mock((_key: string | null) => {});
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("combobox"));
  await user.click(screen.getByRole("option", { name: "Charlie" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeTruthy();
});

test("emptyText shows outside the listbox when nothing matches", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
      emptyText="Nothing here"
    />,
  );
  await user.type(screen.getByRole("combobox"), "zzz");
  const empty = screen.getByText("Nothing here");
  expect(screen.queryAllByRole("option")).toHaveLength(0);
  expect(screen.getByRole("listbox").contains(empty)).toBe(false);
});

test("aria-expanded, aria-controls and aria-selected reflect state", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox label="Fruit" options={options} value="b" onChange={() => {}} />,
  );
  const input = screen.getByRole("combobox");
  expect(input.getAttribute("aria-expanded")).toBe("false");
  expect(input.hasAttribute("data-open")).toBe(false);
  await user.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  expect(input.hasAttribute("data-open")).toBe(true);
  expect(input.getAttribute("aria-controls")).toBe(
    screen.getByRole("listbox").id,
  );
  expect(
    screen.getByRole("option", { name: "Beta" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByRole("option", { name: "Alpha" }).getAttribute("aria-selected"),
  ).toBe("false");
});

test("input has a real label", () => {
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole("combobox");
  expect(input.hasAttribute("aria-label")).toBe(false);
  expect(document.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
    "Fruit",
  );
});

test("reopening with the selected label shows all options", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox label="Fruit" options={options} value="b" onChange={() => {}} />,
  );
  await user.click(screen.getByRole("combobox"));
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

test("controlled value shows its label", () => {
  const { rerender } = render(
    <Combobox label="Fruit" options={options} value="a" onChange={() => {}} />,
  );
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
    "Alpha",
  );
  rerender(
    <Combobox label="Fruit" options={options} value="b" onChange={() => {}} />,
  );
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("Beta");
});

test("with onInputChange the consumer filters and the built-in filter is off", async () => {
  const user = userEvent.setup({ delay: null });
  const onInputChange = mock((_text: string) => {});
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
      onInputChange={onInputChange}
    />,
  );
  await user.type(screen.getByRole("combobox"), "bet");
  expect(onInputChange).toHaveBeenLastCalledWith("bet");
  expect(screen.getAllByRole("option")).toHaveLength(3);
});

test("className goes on the input only", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
      className="field"
    />,
  );
  await user.click(screen.getByRole("combobox"));
  expect(screen.getByRole("combobox").className).toBe("field");
  expect(screen.getByRole("listbox").className).toBe("");
});

test("an external value change replaces the typed text", async () => {
  const user = userEvent.setup({ delay: null });
  const { rerender } = render(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await user.click(input);
  await user.click(screen.getByRole("option", { name: "Alpha" }));
  expect(input.value).toBe("Alpha");
  rerender(
    <Combobox label="Fruit" options={options} value="b" onChange={() => {}} />,
  );
  expect(input.value).toBe("Beta");
  rerender(
    <Combobox
      label="Fruit"
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  expect(input.value).toBe("");
});

test("list inside a modal Dialog renders in the dialog and in the top layer", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Dialog open onClose={() => {}} title="Edit">
      <Combobox
        label="Fruit"
        options={options}
        value={null}
        onChange={() => {}}
      />
    </Dialog>,
  );
  await user.click(screen.getByRole("combobox"));
  const list = screen.getByRole("listbox").parentElement!;
  expect(list.closest("dialog")).toBe(
    screen.getByRole("dialog", { name: "Edit" }),
  );
  expect(list.getAttribute("popover")).toBe("manual");
});

test("Combobox hideLabel keeps the label for screen readers only", () => {
  render(
    <Combobox
      label="Pick"
      hideLabel
      options={options}
      value={null}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("Pick").className).toContain("sr-only");
  expect(screen.getByRole("combobox", { name: "Pick" })).toBeTruthy();
});
