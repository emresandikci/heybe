import { act, renderHook } from "@testing-library/react";
import { expect, test } from "bun:test";
import { useListState } from "./useListState.js";

test("useListState next wraps and skips disabled keys", () => {
  const { result } = renderHook(() =>
    useListState({ keys: ["a", "b", "c"], disabledKeys: ["b"] }),
  );
  act(() => result.current.setActiveKey("c"));
  act(() => result.current.next());
  expect(result.current.activeKey).toBe("a");
});

test("useListState previous, first and last skip disabled keys", () => {
  const { result } = renderHook(() =>
    useListState({ keys: ["a", "b", "c", "d"], disabledKeys: ["a", "d"] }),
  );
  act(() => result.current.previous());
  expect(result.current.activeKey).toBe("c");
  act(() => result.current.previous());
  expect(result.current.activeKey).toBe("b");
  act(() => result.current.last());
  expect(result.current.activeKey).toBe("c");
  act(() => result.current.first());
  expect(result.current.activeKey).toBe("b");
});
