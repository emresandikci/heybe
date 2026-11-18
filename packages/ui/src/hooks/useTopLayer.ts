import { useLayoutEffect, type RefObject } from "react";

// A modal dialog makes everything outside it inert, so overlays render inside the open dialog.
// showPopover puts them in the top layer, out of the dialog's clipping and backdrop-filter containing block.
export function useTopLayer(
  triggerRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  open: boolean,
): Element | null {
  useLayoutEffect(() => {
    if (open) overlayRef.current?.showPopover?.();
  }, [open, overlayRef]);
  return open
    ? (triggerRef.current?.closest("dialog[open]") ?? document.body)
    : null;
}
