import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { createRef } from "react";
import { usePosition } from "./usePosition.js";

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

const { innerWidth, innerHeight } = window;
afterEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: innerWidth,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: innerHeight,
  });
});

function setup(
  triggerRect: DOMRect,
  overlayRect: DOMRect,
  placement: Parameters<typeof usePosition>[2]["placement"],
) {
  const trigger = createRef<HTMLElement>();
  const overlay = createRef<HTMLElement>();
  trigger.current = document.createElement("button");
  overlay.current = document.createElement("div");
  trigger.current.getBoundingClientRect = () => triggerRect;
  overlay.current.getBoundingClientRect = () => overlayRect;
  return renderHook(() =>
    usePosition(trigger, overlay, { open: true, placement }),
  ).result;
}

test("usePosition flips above when there is no room below", () => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 300,
  });
  const trigger = createRef<HTMLElement>();
  const overlay = createRef<HTMLElement>();
  trigger.current = document.createElement("button");
  overlay.current = document.createElement("div");
  trigger.current.getBoundingClientRect = () => rect(40, 270, 80, 20);
  overlay.current.getBoundingClientRect = () => rect(0, 0, 120, 100);
  const { result } = renderHook(() =>
    usePosition(trigger, overlay, { open: true, placement: "bottom-start" }),
  );
  expect(result.current.placement).toBe("top-start");
});

test("usePosition shifts left inside the viewport", () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 300,
  });
  const trigger = createRef<HTMLElement>();
  const overlay = createRef<HTMLElement>();
  trigger.current = document.createElement("button");
  overlay.current = document.createElement("div");
  trigger.current.getBoundingClientRect = () => rect(280, 20, 15, 20);
  overlay.current.getBoundingClientRect = () => rect(0, 0, 100, 60);
  const { result } = renderHook(() =>
    usePosition(trigger, overlay, { open: true, placement: "bottom-start" }),
  );
  expect(Number.parseFloat(String(result.current.style.left))).toBe(192);
});

test("usePosition centers top and bottom on the trigger", () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 500,
  });
  const result = setup(rect(200, 100, 40, 20), rect(0, 0, 100, 50), "bottom");
  expect(result.current.style.left).toBe(170);
  expect(result.current.placement).toBe("bottom");
});

test("usePosition keeps end alignment when flipping", () => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 300,
  });
  const result = setup(
    rect(300, 270, 80, 20),
    rect(0, 0, 120, 100),
    "bottom-end",
  );
  expect(result.current.placement).toBe("top-end");
  expect(result.current.style.left).toBe(260);
});

test("usePosition re-measures when the overlay resizes", () => {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 300,
  });
  const original = globalThis.ResizeObserver;
  let notify = () => {};
  const observed: Element[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      notify = callback;
    }
    observe(element: Element) {
      observed.push(element);
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  try {
    let height = 200;
    const trigger = createRef<HTMLElement>();
    const overlay = createRef<HTMLElement>();
    trigger.current = document.createElement("input");
    overlay.current = document.createElement("div");
    trigger.current.getBoundingClientRect = () => rect(40, 250, 120, 30);
    overlay.current.getBoundingClientRect = () => rect(0, 0, 120, height);
    const { result } = renderHook(() =>
      usePosition(trigger, overlay, { open: true, placement: "bottom-start" }),
    );
    expect(observed).toContain(overlay.current);
    expect(result.current.style.top).toBe(46);
    height = 60;
    act(() => notify());
    expect(result.current.style.top).toBe(186);
    expect(result.current.style).toMatchObject({
      margin: 0,
      right: "auto",
      bottom: "auto",
    });
  } finally {
    globalThis.ResizeObserver = original;
  }
});

test("usePosition removes its window listeners and observer on close and on unmount", () => {
  const original = globalThis.ResizeObserver;
  let disconnects = 0;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {
      disconnects++;
    }
  } as unknown as typeof ResizeObserver;
  const added = spyOn(window, "addEventListener");
  const removed = spyOn(window, "removeEventListener");
  try {
    const trigger = createRef<HTMLElement>();
    const overlay = createRef<HTMLElement>();
    trigger.current = document.createElement("button");
    overlay.current = document.createElement("div");
    const { rerender, unmount } = renderHook(
      ({ open }) => usePosition(trigger, overlay, { open }),
      { initialProps: { open: true } },
    );
    const types = added.mock.calls.map((call) => call[0]);
    expect(types).toEqual(expect.arrayContaining(["resize", "scroll"]));
    rerender({ open: false });
    expect(disconnects).toBe(1);
    const closed = removed.mock.calls.map((call) => call[0]);
    expect(closed).toEqual(expect.arrayContaining(["resize", "scroll"]));
    added.mockClear();
    removed.mockClear();
    rerender({ open: true });
    unmount();
    expect(disconnects).toBe(2);
    for (const [type, handler] of added.mock.calls.filter(
      (call) => call[0] === "resize" || call[0] === "scroll",
    )) {
      expect(
        removed.mock.calls.some((c) => c[0] === type && c[1] === handler),
      ).toBe(true);
    }
  } finally {
    added.mockRestore();
    removed.mockRestore();
    globalThis.ResizeObserver = original;
  }
});
