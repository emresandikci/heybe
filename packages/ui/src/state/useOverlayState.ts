import { useCallback } from "react";
import { useControlledState } from "./useControlledState.js";

export function useOverlayState(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useControlledState(
    props.open,
    props.defaultOpen ?? false,
    props.onOpenChange,
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  return { open, setOpen, toggle, close };
}
