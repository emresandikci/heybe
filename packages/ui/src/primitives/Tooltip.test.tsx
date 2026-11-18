import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { createRef } from "react";
import { Dialog } from "./Dialog.js";
import { Tooltip } from "./Tooltip.js";

let day = 0;
beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(new Date(Date.UTC(2020, 0, ++day)));
});
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

test("Tooltip shows after the delay on hover and immediately hides on Escape", () => {
  render(
    <Tooltip content="Help">
      <button>Target</button>
    </Tooltip>,
  );
  const target = screen.getByRole("button");
  fireEvent.mouseEnter(target);
  expect(screen.queryByRole("tooltip")).toBeNull();
  act(() => {
    jest.advanceTimersByTime(700);
  });
  const tip = screen.getByRole("tooltip");
  expect(target.getAttribute("aria-describedby")).toBe(tip.id);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("Tooltip opens on keyboard focus and closes on blur", () => {
  render(
    <Tooltip content="Help">
      <button>Target</button>
    </Tooltip>,
  );
  const target = screen.getByRole("button");
  fireEvent.focus(target);
  act(() => {
    jest.advanceTimersByTime(700);
  });
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.blur(target);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("Tooltip keeps a caller ref on the trigger", () => {
  const ref = createRef<HTMLButtonElement>();
  render(
    <Tooltip content="Help">
      <button ref={ref}>Target</button>
    </Tooltip>,
  );
  expect(ref.current).toBe(screen.getByRole("button"));
});

test("Tooltip stays open while the pointer is over it", () => {
  render(
    <Tooltip content="Help">
      <button>Target</button>
    </Tooltip>,
  );
  const target = screen.getByRole("button");
  fireEvent.mouseEnter(target);
  act(() => {
    jest.advanceTimersByTime(700);
  });
  fireEvent.mouseLeave(target);
  fireEvent.mouseEnter(screen.getByRole("tooltip"));
  act(() => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("tooltip")).toBeTruthy();
  fireEvent.mouseLeave(screen.getByRole("tooltip"));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("Tooltip closes after leaving the trigger without entering it", () => {
  render(
    <Tooltip content="Help">
      <button>Target</button>
    </Tooltip>,
  );
  const target = screen.getByRole("button");
  fireEvent.mouseEnter(target);
  act(() => {
    jest.advanceTimersByTime(700);
  });
  fireEvent.mouseLeave(target);
  act(() => {
    jest.advanceTimersByTime(200);
  });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

test("Tooltip inside a modal Dialog renders in the dialog and in the top layer", () => {
  render(
    <Dialog open onClose={() => {}} title="Edit">
      <Tooltip content="Help">
        <button>Target</button>
      </Tooltip>
    </Dialog>,
  );
  fireEvent.focus(screen.getByRole("button", { name: "Target" }));
  act(() => {
    jest.advanceTimersByTime(700);
  });
  const tip = screen.getByRole("tooltip");
  expect(tip.closest("dialog")).toBe(
    screen.getByRole("dialog", { name: "Edit" }),
  );
  expect(tip.getAttribute("popover")).toBe("manual");
});
