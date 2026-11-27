import { describe, expect, test } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { THEME_KEY, applyTheme, resolveTheme, useTheme } from "./theme";

describe("theme", () => {
  test('resolveTheme follows the system only for "system"', () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  test("applyTheme sets data-theme and persists hb_theme", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  test("applyTheme survives broken storage", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      applyTheme("light");
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

test("useTheme follows OS changes only while the choice is system", () => {
  let dark = false;
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = (() => ({
    get matches() {
      return dark;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  try {
    const { result } = renderHook(() => useTheme());
    dark = true;
    act(() => listeners.forEach((fn) => fn()));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current[1]("light"));
    expect(listeners.size).toBe(0);
  } finally {
    window.matchMedia = original;
  }
});
