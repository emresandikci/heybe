import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";
import { useTooltipDelay } from "./useTooltipDelay.js";

let day = 0;
beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(new Date(2026, 0, ++day));
});
afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

function openFirst() {
  const first = renderHook(() => useTooltipDelay());
  act(() => first.result.current.onEnter());
  expect(first.result.current.open).toBe(false);
  act(() => jest.advanceTimersByTime(700));
  expect(first.result.current.open).toBe(true);
  return first;
}

test("useTooltipDelay opens after 700ms and opens instantly during warm-up", () => {
  const first = openFirst();
  act(() => first.result.current.onLeave());
  expect(first.result.current.open).toBe(false);
  act(() => jest.advanceTimersByTime(299));
  const next = renderHook(() => useTooltipDelay());
  act(() => next.result.current.onEnter());
  expect(next.result.current.open).toBe(true);
});

test("useTooltipDelay warm-up starts when a tooltip closes, not when it opens", () => {
  const first = openFirst();
  act(() => jest.advanceTimersByTime(1000));
  act(() => first.result.current.onLeave());
  act(() => jest.advanceTimersByTime(301));
  const next = renderHook(() => useTooltipDelay());
  act(() => next.result.current.onEnter());
  expect(next.result.current.open).toBe(false);
  act(() => jest.advanceTimersByTime(700));
  expect(next.result.current.open).toBe(true);
});

test("useTooltipDelay stays warm after a long hover once it closes", () => {
  const first = openFirst();
  act(() => jest.advanceTimersByTime(1000));
  act(() => first.result.current.onLeave());
  act(() => jest.advanceTimersByTime(100));
  const next = renderHook(() => useTooltipDelay());
  act(() => next.result.current.onEnter());
  expect(next.result.current.open).toBe(true);
});
