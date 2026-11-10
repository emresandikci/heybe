import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_KEY = "heybe_theme";

export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): "light" | "dark" {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

function prefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark" || value === "system")
      return value;
  } catch {}
  return "system";
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice, prefersDark());
  try {
    localStorage.setItem(THEME_KEY, choice);
  } catch {}
}

export function initTheme(): void {
  applyTheme(stored());
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState(stored);
  const set = useCallback((next: ThemeChoice) => {
    applyTheme(next);
    setChoice(next);
  }, []);
  useEffect(() => {
    if (choice !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [choice]);
  return [choice, set];
}
