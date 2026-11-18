import { useCallback, useEffect, useRef, useState } from "react";

let warmUntil = 0;
export function useTooltipDelay(): {
  open: boolean;
  onEnter(): void;
  onLeave(): void;
} {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEnter = useCallback(() => {
    clearTimeout(timer.current);
    if (Date.now() < warmUntil) {
      setOpen(true);
      return;
    }
    timer.current = setTimeout(() => setOpen(true), 700);
  }, []);
  const onLeave = useCallback(() => {
    clearTimeout(timer.current);
    if (openRef.current) warmUntil = Date.now() + 300;
    setOpen(false);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { open, onEnter, onLeave };
}
