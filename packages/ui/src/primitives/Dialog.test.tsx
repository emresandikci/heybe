import { expect, mock, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Dialog } from "./Dialog.js";

test("Dialog opens with showModal, Esc closes and focus returns to the opener", async () => {
  const user = userEvent.setup({ delay: null });
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
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Hello" });
  expect((dialog as HTMLDialogElement).open).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("Esc in a nested Dialog closes only the inner one", async () => {
  const user = userEvent.setup({ delay: null });
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
  await user.click(screen.getByRole("button", { name: "Open inner" }));
  expect(screen.getByRole("dialog", { name: "Inner" })).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
});

function Host(props: { onClose?(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <Dialog
        open={open}
        onClose={() => {
          props.onClose?.();
          setOpen(false);
        }}
        title="Hello"
      >
        <button>Inside</button>
      </Dialog>
    </>
  );
}

test("Dialog unmounted after close does not move focus", async () => {
  const user = userEvent.setup({ delay: null });
  const { unmount } = render(
    <>
      <Host />
      <input aria-label="Other" />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.keyboard("{Escape}");
  const other = screen.getByLabelText("Other");
  act(() => other.focus());
  unmount();
  expect(document.activeElement).toBe(document.body);
});

test("Dialog unmounted while open returns focus to the opener", async () => {
  const user = userEvent.setup({ delay: null });
  const { unmount } = render(<Host />);
  const open = screen.getByRole("button", { name: "Open" });
  await user.click(open);
  const focus = mock(() => {});
  open.focus = focus;
  unmount();
  expect(focus).toHaveBeenCalledTimes(1);
});

test("Dialog calls onClose on the native close event", async () => {
  const user = userEvent.setup({ delay: null });
  let closed = 0;
  render(<Host onClose={() => closed++} />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  act(() => (screen.getByRole("dialog") as HTMLDialogElement).close());
  expect(closed).toBe(1);
});
