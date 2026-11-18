import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEventHandler,
} from "react";
import type { useListState } from "../state/useListState.js";

export function useListKeyboard<K extends string>(
  list: ReturnType<typeof useListState<K>>,
  opts: {
    orientation: "vertical" | "horizontal";
    labels: Record<string, string>;
    onSelect?(key: string): void;
  },
): { onKeyDown: KeyboardEventHandler } {
  const buffer = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onKeyDown: KeyboardEventHandler = useCallback(
    (event) => {
      const horizontal = opts.orientation === "horizontal";
      if (
        (!horizontal && event.key === "ArrowDown") ||
        (horizontal && event.key === "ArrowRight")
      ) {
        event.preventDefault();
        list.next();
        return;
      }
      if (
        (!horizontal && event.key === "ArrowUp") ||
        (horizontal && event.key === "ArrowLeft")
      ) {
        event.preventDefault();
        list.previous();
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        list.first();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        list.last();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && list.activeKey) {
        event.preventDefault();
        opts.onSelect?.(list.activeKey);
        return;
      }
      if (
        event.key.length !== 1 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      buffer.current += event.key.toLocaleLowerCase();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        buffer.current = "";
      }, 500);
      const keys = list.enabledKeys;
      const current = list.activeKey ? keys.indexOf(list.activeKey) : -1;
      for (let i = 1; i <= keys.length; i++) {
        const key = keys[(current + i) % keys.length]!;
        if (opts.labels[key]?.toLocaleLowerCase().startsWith(buffer.current)) {
          list.setActiveKey(key as K);
          break;
        }
      }
    },
    [list, opts],
  );
  useEffect(() => () => clearTimeout(timer.current), []);
  return { onKeyDown };
}
