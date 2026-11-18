import { act, renderHook } from "@testing-library/react";
import { expect, test, mock } from "bun:test";
import { useControlledState } from "./useControlledState.js";

test("useControlledState calls onChange and ignores internal state when controlled", () => {
  const onChange = mock(() => {});
  const { result, rerender } = renderHook(
    ({ value }) => useControlledState(value, "default", onChange),
    { initialProps: { value: "controlled" as string | undefined } },
  );
  act(() => result.current[1]("next"));
  expect(onChange).toHaveBeenCalledWith("next");
  expect(result.current[0]).toBe("controlled");
  rerender({ value: "updated" });
  expect(result.current[0]).toBe("updated");
});
