import { act, render, renderHook } from "@testing-library/react";
import { expect, mock, test } from "bun:test";
import { createRef } from "react";
import { useDismiss } from "./useDismiss.js";

const escape = () =>
  new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });

test("useDismiss closes on Escape and outside pointerdown, not on trigger pointerdown", () => {
  const ref = createRef<HTMLDivElement>();
  const triggerRef = createRef<HTMLButtonElement>();
  const onDismiss = mock(() => {});
  const { rerender } = renderHook(
    ({ open }) => useDismiss(ref, { open, onDismiss, triggerRef }),
    { initialProps: { open: true } },
  );
  render(
    <>
      <div ref={ref} data-testid="overlay" />
      <button ref={triggerRef} data-testid="trigger" />
    </>,
  );
  act(() =>
    document
      .querySelector("[data-testid=trigger]")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
  );
  expect(onDismiss).not.toHaveBeenCalled();
  act(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    ),
  );
  expect(onDismiss).toHaveBeenCalledTimes(1);
  onDismiss.mockClear();
  act(() => document.dispatchEvent(escape()));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  onDismiss.mockClear();
  rerender({ open: false });
  act(() => document.dispatchEvent(escape()));
  act(() =>
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    ),
  );
  expect(onDismiss).not.toHaveBeenCalled();
});

test("useDismiss Escape does not reach an outer listener", () => {
  const outer = mock(() => {});
  const onDismiss = mock(() => {});
  const { getByTestId } = render(
    <div onKeyDown={outer}>
      <div data-testid="overlay" />
    </div>,
  );
  const ref = { current: getByTestId("overlay") };
  renderHook(() => useDismiss(ref, { open: true, onDismiss }));
  act(() => getByTestId("overlay").dispatchEvent(escape()));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
});

test("useDismiss only the innermost open layer handles Escape", () => {
  const outerKey = mock(() => {});
  const outerDismiss = mock(() => {});
  const innerDismiss = mock(() => {});
  const { getByTestId } = render(
    <div onKeyDown={outerKey}>
      <div data-testid="outer">
        <div data-testid="inner" />
      </div>
    </div>,
  );
  const outerRef = { current: getByTestId("outer") };
  const innerRef = { current: getByTestId("inner") };
  renderHook(() =>
    useDismiss(outerRef, { open: true, onDismiss: outerDismiss }),
  );
  renderHook(() =>
    useDismiss(innerRef, { open: true, onDismiss: innerDismiss }),
  );
  act(() => getByTestId("inner").dispatchEvent(escape()));
  expect(innerDismiss).toHaveBeenCalledTimes(1);
  expect(outerDismiss).not.toHaveBeenCalled();
  expect(outerKey).not.toHaveBeenCalled();
});

test("useDismiss re-render of an outer layer does not steal Escape from the inner one", () => {
  const outerDismiss = mock(() => {});
  const innerDismiss = mock(() => {});
  const { getByTestId } = render(
    <div data-testid="outer">
      <div data-testid="inner" />
    </div>,
  );
  const outerRef = { current: getByTestId("outer") };
  const innerRef = { current: getByTestId("inner") };
  const outer = renderHook(() =>
    useDismiss(outerRef, { open: true, onDismiss: () => outerDismiss() }),
  );
  renderHook(() =>
    useDismiss(innerRef, { open: true, onDismiss: innerDismiss }),
  );
  outer.rerender();
  act(() => getByTestId("inner").dispatchEvent(escape()));
  expect(innerDismiss).toHaveBeenCalledTimes(1);
  expect(outerDismiss).not.toHaveBeenCalled();
});
