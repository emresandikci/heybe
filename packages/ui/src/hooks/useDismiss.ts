import { useEffect, useRef, type RefObject } from "react";

const layers: symbol[] = [];

export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  opts: {
    open: boolean;
    onDismiss(): void;
    triggerRef?: RefObject<HTMLElement | null>;
  },
): void {
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    if (!opts.open) return;
    const layer = Symbol();
    layers.push(layer);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || layers[layers.length - 1] !== layer) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current.onDismiss();
    };
    const pointerdown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        ref.current?.contains(target) ||
        latest.current.triggerRef?.current?.contains(target)
      )
        return;
      latest.current.onDismiss();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown);
    };
  }, [ref, opts.open]);
}
