import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, mock, test } from "bun:test";
import { createRef } from "react";
import { Dialog } from "./Dialog.js";
import { Menu, type MenuItem } from "./Menu.js";

const items: MenuItem[] = [
  { key: "a", label: "Alpha", disabled: true },
  { key: "b", label: "Beta" },
  { separator: true },
  { key: "c", label: "Charlie" },
];

test("Menu ArrowDown on trigger opens and focuses the first enabled item", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  screen.getByRole("button").focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Beta" }),
  );
  expect(
    screen
      .getByRole("menuitem", { name: "Alpha" })
      .hasAttribute("data-disabled"),
  ).toBe(true);
  expect(document.activeElement?.hasAttribute("data-active")).toBe(true);
});

test("Menu ArrowUp on the trigger focuses the last item", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  screen.getByRole("button").focus();
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Charlie" }),
  );
});

test("Menu Enter calls onAction with the key and closes", async () => {
  const user = userEvent.setup({ delay: null });
  const onAction = mock((_key: string) => {});
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={onAction} />,
  );
  screen.getByRole("button").focus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onAction).toHaveBeenCalledWith("b");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button"));
});

test("Menu typeahead focuses the matching item", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  screen.getByRole("button").focus();
  await user.keyboard("{ArrowDown}c");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Charlie" }),
  );
});

test("Menu Tab closes it", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  screen.getByRole("button").focus();
  await user.keyboard("{ArrowDown}{Tab}");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Menu inside a modal Dialog renders in the dialog, in the top layer, and Escape closes only the Menu", async () => {
  const user = userEvent.setup({ delay: null });
  const onClose = mock(() => {});
  render(
    <Dialog open onClose={onClose} title="Edit">
      <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />
    </Dialog>,
  );
  const dialog = screen.getByRole("dialog", {
    name: "Edit",
  }) as HTMLDialogElement;
  await user.click(screen.getByRole("button", { name: "Menu" }));
  const menu = screen.getByRole("menu");
  expect(menu.closest("dialog")).toBe(dialog);
  expect(menu.getAttribute("popover")).toBe("manual");
  const notCanceled = fireEvent.keyDown(
    screen.getByRole("menuitem", { name: "Beta" }),
    { key: "Escape" },
  );
  expect(notCanceled).toBe(false);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog.open).toBe(true);
});

test("Menu keeps a caller ref on the trigger", () => {
  const ref = createRef<HTMLButtonElement>();
  render(
    <Menu
      trigger={<button ref={ref}>Menu</button>}
      items={items}
      onAction={() => {}}
    />,
  );
  expect(ref.current).toBe(screen.getByRole("button"));
});

test("Menu opened by click or Enter focuses the first enabled item", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  await user.click(screen.getByRole("button"));
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Beta" }),
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Beta" }),
  );
});

test("Menu trigger and menu are wired with aria", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  const trigger = screen.getByRole("button");
  await user.click(trigger);
  const menu = screen.getByRole("menu", { name: "Menu" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.getAttribute("aria-controls")).toBe(menu.id);
});

test("Menu item click calls onAction and closes, disabled item does nothing", async () => {
  const user = userEvent.setup({ delay: null });
  const onAction = mock((_key: string) => {});
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={onAction} />,
  );
  await user.click(screen.getByRole("button"));
  await user.click(screen.getByRole("menuitem", { name: "Alpha" }));
  expect(onAction).not.toHaveBeenCalled();
  expect(screen.getByRole("menu")).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "Charlie" }));
  expect(onAction).toHaveBeenCalledWith("c");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Menu separators are not focusable", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />,
  );
  await user.click(screen.getByRole("button"));
  expect(screen.getByRole("separator").hasAttribute("tabindex")).toBe(false);
});

test("Menu outside click closes and returns focus to the trigger", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <>
      <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />
      <p>outside</p>
    </>,
  );
  await user.click(screen.getByRole("button"));
  await user.click(screen.getByText("outside"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button"));
});

test("Menu outside click on another input leaves focus there", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <>
      <Menu trigger={<button>Menu</button>} items={items} onAction={() => {}} />
      <input aria-label="other" />
    </>,
  );
  await user.click(screen.getByRole("button"));
  await user.click(screen.getByLabelText("other"));
  expect(document.activeElement).toBe(screen.getByLabelText("other"));
});

test("Menu renders checked items as menuitemradio with a heading label", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Menu
      trigger={<button>Menu</button>}
      items={[
        { heading: "Theme" },
        { key: "l", label: "Light", checked: false },
        { key: "d", label: "Dark", checked: true },
      ]}
      onAction={() => {}}
    />,
  );
  await user.click(screen.getByRole("button"));
  expect(screen.getByText("Theme")).toBeTruthy();
  expect(
    screen
      .getByRole("menuitemradio", { name: "Dark" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("menuitemradio", { name: "Light" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});

test("Menu opens focused on the checked item by click and by keyboard", async () => {
  const user = userEvent.setup({ delay: null });
  const radios: MenuItem[] = [
    { key: "x", label: "One", checked: false },
    { key: "y", label: "Two", checked: true },
  ];
  render(
    <Menu trigger={<button>Menu</button>} items={radios} onAction={() => {}} />,
  );
  const trigger = screen.getByRole("button");
  await user.click(trigger);
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Two" }),
  );
  await user.keyboard("{Escape}");
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Two" }),
  );
  await user.keyboard("{Escape}");
  trigger.focus();
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitemradio", { name: "Two" }),
  );
});
