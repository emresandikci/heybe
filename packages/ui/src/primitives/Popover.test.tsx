import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "bun:test";
import { createRef } from "react";
import { Dialog } from "./Dialog.js";
import { Popover } from "./Popover.js";

test("Popover moves focus in and returns it to the trigger on close", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Popover trigger={<button>Open</button>} label="Details">
      <button>Inside</button>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Open" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Details" });
  expect(dialog.parentElement).toBe(document.body);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(dialog.hasAttribute("data-open")).toBe(true);
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Popover keeps a caller ref on the trigger", () => {
  const ref = createRef<HTMLButtonElement>();
  render(<Popover trigger={<button ref={ref}>Open</button>}>x</Popover>);
  expect(ref.current).toBe(screen.getByRole("button"));
});

test("Popover outside click closes and returns focus to the trigger", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <>
      <Popover trigger={<button>Open</button>}>
        <button>Inside</button>
      </Popover>
      <p>outside</p>
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(screen.getByText("outside"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Open" }),
  );
});

test("Popover outside click on another input leaves focus there", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <>
      <Popover trigger={<button>Open</button>}>x</Popover>
      <input aria-label="other" />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(screen.getByLabelText("other"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("other"));
});

test("Popover inside a modal Dialog renders in the dialog and in the top layer", async () => {
  const user = userEvent.setup({ delay: null });
  render(
    <Dialog open onClose={() => {}} title="Edit">
      <Popover trigger={<button>Open</button>} label="Details">
        x
      </Popover>
    </Dialog>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));
  const popover = screen.getByRole("dialog", { name: "Details" });
  expect(popover.closest("dialog")).toBe(
    screen.getByRole("dialog", { name: "Edit" }),
  );
  expect(popover.getAttribute("popover")).toBe("manual");
});
