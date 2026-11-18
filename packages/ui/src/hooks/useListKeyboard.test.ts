import { act, renderHook } from "@testing-library/react";
import { expect, jest, test } from "bun:test";
import { useListKeyboard } from "./useListKeyboard.js";
import { useListState } from "../state/useListState.js";

test("useListKeyboard typeahead jumps to the first label starting with typed text", () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => {
      const list = useListState({ keys: ["a", "b", "c"] });
      const keyboard = useListKeyboard(list, {
        orientation: "vertical",
        labels: { a: "Apple", b: "Banana", c: "Cherry" },
      });
      return { list, keyboard };
    });
    act(() =>
      result.current.keyboard.onKeyDown({ key: "c" } as React.KeyboardEvent),
    );
    expect(result.current.list.activeKey).toBe("c");
    act(() => jest.advanceTimersByTime(501));
    act(() =>
      result.current.keyboard.onKeyDown({ key: "b" } as React.KeyboardEvent),
    );
    expect(result.current.list.activeKey).toBe("b");
  } finally {
    jest.useRealTimers();
  }
});

test("useListKeyboard typeahead skips disabled keys and follows list order", () => {
  jest.useFakeTimers();
  try {
    const { result } = renderHook(() => {
      const list = useListState({ keys: ["b", "a", "c"], disabledKeys: ["b"] });
      const keyboard = useListKeyboard(list, {
        orientation: "vertical",
        labels: { b: "Baz", a: "Bar", c: "Cat" },
      });
      return { list, keyboard };
    });
    act(() =>
      result.current.keyboard.onKeyDown({ key: "b" } as React.KeyboardEvent),
    );
    expect(result.current.list.activeKey).toBe("a");
  } finally {
    jest.useRealTimers();
  }
});

test("useListKeyboard clears the typeahead timer on unmount", () => {
  jest.useFakeTimers();
  try {
    const { result, unmount } = renderHook(() => {
      const list = useListState({ keys: ["a"] });
      return useListKeyboard(list, {
        orientation: "vertical",
        labels: { a: "Apple" },
      });
    });
    act(() => result.current.onKeyDown({ key: "a" } as React.KeyboardEvent));
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
