import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { useState } from "react";
import { ConfirmProvider, useConfirm } from "./Confirm.js";
import { CopyButton } from "./CopyButton.js";
import { Dialog } from "./Dialog.js";
import { Menu } from "./Menu.js";
import { Tabs } from "./Tabs.js";
import { ToastProvider, useToast } from "./Toasts.js";

beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(new Date(Date.UTC(2021, 0, 1)));
});
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

const user = () =>
  userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });

test("Dialog opens with showModal, Esc closes and focus returns to the opener", async () => {
  const u = user();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Hello">
          <button>Inside</button>
        </Dialog>
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Open" });
  await u.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Hello" });
  expect((dialog as HTMLDialogElement).open).toBe(true);
  await u.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("Esc in a nested Dialog closes only the inner one", async () => {
  const u = user();
  function Host() {
    const [inner, setInner] = useState(false);
    const [outer, setOuter] = useState(true);
    return (
      <Dialog open={outer} onClose={() => setOuter(false)} title="Outer">
        <button onClick={() => setInner(true)}>Open inner</button>
        <Dialog open={inner} onClose={() => setInner(false)} title="Inner">
          <button>Inside inner</button>
        </Dialog>
      </Dialog>
    );
  }
  render(<Host />);
  await u.click(screen.getByRole("button", { name: "Open inner" }));
  expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();
  await u.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
});

test("Dialog close button closes and returns focus", async () => {
  const u = user();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Hello">
          <input aria-label="First" />
        </Dialog>
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Open" });
  await u.click(opener);
  expect(document.activeElement).toBe(screen.getByLabelText("First"));
  await u.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("Dialog footer renders inside the footer band", () => {
  render(
    <Dialog
      open
      onClose={() => {}}
      title="Hello"
      footer={<button>Save</button>}
    >
      body
    </Dialog>,
  );
  const band = screen.getByRole("button", { name: "Save" }).parentElement!;
  expect(band.getAttribute("data-part")).toBe("footer");
  expect(screen.getByRole("dialog").className).toContain(
    "[&_[data-part=footer]]:flex-wrap",
  );
});

test("Dialog size lg widens the centered dialog", () => {
  render(
    <Dialog open size="lg" onClose={() => {}} title="Wide">
      body
    </Dialog>,
  );
  const cls = screen.getByRole("dialog").className;
  expect(cls).toContain("max-w-3xl");
  expect(cls).not.toContain("max-w-lg");
});

test("Tabs selected tab has the accent underline and text class", () => {
  render(
    <Tabs
      label="S"
      value="a"
      onChange={() => {}}
      tabs={[{ value: "a", label: "Alpha" }]}
    />,
  );
  const cls = screen.getByRole("tablist").className;
  expect(cls).toContain("[&_[role=tab][data-selected]]:border-accent");
  expect(cls).toContain("[&_[role=tab][data-selected]]:text-text");
});

test("Tabs move with ArrowRight and ArrowLeft", async () => {
  const u = user();
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
  screen.getByRole("tab", { name: "Alpha" }).focus();
  await u.keyboard("{ArrowRight}");
  const beta = screen.getByRole("tab", { name: "Beta" });
  expect(beta.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(beta);
  await u.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(
    screen.getByRole("tab", { name: "Gamma" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("useConfirm with typeToConfirm keeps Confirm disabled until the text matches", async () => {
  const u = user();
  let result: boolean | undefined;
  function Host() {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () => {
          result = await confirm({
            title: "Delete posts",
            message: "This cannot be undone.",
            confirmLabel: "Delete",
            danger: true,
            typeToConfirm: "posts",
          });
        }}
      >
        Ask
      </button>
    );
  }
  render(
    <ConfirmProvider>
      <Host />
    </ConfirmProvider>,
  );
  await u.click(screen.getByRole("button", { name: "Ask" }));
  const confirmButton = screen.getByRole("button", {
    name: "Delete",
  }) as HTMLButtonElement;
  expect(confirmButton.disabled).toBe(true);
  await u.type(screen.getByLabelText(/Type "posts"/), "posts");
  expect(confirmButton.disabled).toBe(false);
  await u.click(confirmButton);
  expect(result).toBe(true);
});

test("useConfirm resolves false on cancel", async () => {
  const u = user();
  let result: boolean | undefined;
  function Host() {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () => {
          result = await confirm({
            title: "Sure",
            message: "Really?",
            confirmLabel: "Yes",
          });
        }}
      >
        Ask
      </button>
    );
  }
  render(
    <ConfirmProvider>
      <Host />
    </ConfirmProvider>,
  );
  await u.click(screen.getByRole("button", { name: "Ask" }));
  await u.click(screen.getByRole("button", { name: "Cancel" }));
  expect(result).toBe(false);
});

test("a second confirm resolves the pending one with false", async () => {
  const u = user();
  const results: boolean[] = [];
  function Host() {
    const confirm = useConfirm();
    return (
      <button
        onClick={async () =>
          results.push(
            await confirm({ title: "T", message: "M", confirmLabel: "Go" }),
          )
        }
      >
        Ask
      </button>
    );
  }
  render(
    <ConfirmProvider>
      <Host />
    </ConfirmProvider>,
  );
  const ask = screen.getByRole("button", { name: "Ask" });
  await u.click(ask);
  await act(async () => ask.click());
  await u.click(screen.getByRole("button", { name: "Go" }));
  expect(results).toEqual([false, true]);
});

test("Menu danger item uses the danger color class", async () => {
  const u = user();
  render(
    <Menu
      trigger={<button>Actions</button>}
      onAction={() => {}}
      items={[
        { key: "edit", label: "Edit" },
        { separator: true },
        { key: "delete", label: "Delete", danger: true },
      ]}
    />,
  );
  await u.click(screen.getByRole("button", { name: "Actions" }));
  const menu = screen.getByRole("menu");
  expect(menu.className).toContain("[&_[data-danger]]:text-danger-text");
  expect(
    screen
      .getByRole("menuitem", { name: "Delete" })
      .hasAttribute("data-danger"),
  ).toBe(true);
});

test("CopyButton shows the Copied tooltip after click", async () => {
  const u = user();
  const writeText = jest.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(<CopyButton text="secret" />);
  await u.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith("secret");
  act(() => {
    jest.advanceTimersByTime(700);
  });
  expect(screen.getByRole("tooltip").textContent).toBe("Copied");
});

test("CopyButton with showLabel renders its label as visible text", () => {
  render(<CopyButton text="x" label="Copy JSON" showLabel />);
  expect(screen.getByRole("button", { name: "Copy JSON" }).textContent).toBe(
    "Copy JSON",
  );
});

test("CopyButton shows a failed state and announces it when the clipboard rejects", async () => {
  const u = user();
  const writeText = jest.fn(async () => {
    throw new Error("denied");
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(<CopyButton text="secret" />);
  await u.click(screen.getByRole("button", { name: "Copy" }));
  act(() => {
    jest.advanceTimersByTime(700);
  });
  expect(screen.getByRole("tooltip").textContent).toBe("Could not copy");
  expect(screen.getByRole("status").textContent).toBe("Could not copy");
});

test("CopyButton announces Copied through a live region", async () => {
  const u = user();
  const writeText = jest.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  render(<CopyButton text="secret" />);
  expect(screen.getByRole("status").textContent).toBe("");
  await u.click(screen.getByRole("button", { name: "Copy" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Copied");
});

test("Toast error is not nested inside the polite status region", async () => {
  const u = user();
  function Host() {
    const toast = useToast();
    return <button onClick={() => toast.error("Boom")}>Fail</button>;
  }
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  await u.click(screen.getByRole("button", { name: "Fail" }));
  expect(screen.getByRole("alert").closest("[role=status]")).toBeNull();
});

test("Toast error renders role=alert", async () => {
  const u = user();
  function Host() {
    const toast = useToast();
    return <button onClick={() => toast.error("Boom")}>Fail</button>;
  }
  render(
    <ToastProvider>
      <Host />
    </ToastProvider>,
  );
  await u.click(screen.getByRole("button", { name: "Fail" }));
  expect(screen.getByRole("alert").textContent).toContain("Boom");
});

test("Dialog first focus skips disabled controls and hidden sections", async () => {
  const u = user();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Hello">
          <button disabled>Off</button>
          <div hidden>
            <input aria-label="Hidden" />
          </div>
          <input aria-label="Real" />
        </Dialog>
      </>
    );
  }
  render(<Host />);
  await u.click(screen.getByRole("button", { name: "Open" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Real"));
});
