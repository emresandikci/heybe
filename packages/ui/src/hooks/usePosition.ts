import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

type Placement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top"
  | "bottom"
  | "right-start";
type Options = { open: boolean; placement?: Placement; offset?: number };
type Position = { style: CSSProperties; placement: string };

export function usePosition(
  triggerRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  opts: Options,
): Position {
  const placement = opts.placement ?? "bottom";
  const [position, setPosition] = useState<Position>({
    style: { position: "fixed" },
    placement,
  });
  useLayoutEffect(() => {
    if (!opts.open || !triggerRef.current || !overlayRef.current) return;
    const update = () => {
      const trigger = triggerRef.current!.getBoundingClientRect();
      const overlay = overlayRef.current!.getBoundingClientRect();
      const gap = opts.offset ?? 4;
      let side = placement.startsWith("top")
        ? "top"
        : placement === "right-start"
          ? "right"
          : "bottom";
      if (
        side === "bottom" &&
        trigger.bottom + gap + overlay.height > window.innerHeight - 8 &&
        trigger.top - gap - overlay.height >= 8
      )
        side = "top";
      if (
        side === "top" &&
        trigger.top - gap - overlay.height < 8 &&
        trigger.bottom + gap + overlay.height <= window.innerHeight - 8
      )
        side = "bottom";
      const align = placement.endsWith("-end")
        ? "end"
        : placement.endsWith("-start")
          ? "start"
          : "center";
      let left =
        align === "end"
          ? trigger.right - overlay.width
          : align === "center"
            ? trigger.left + trigger.width / 2 - overlay.width / 2
            : trigger.left;
      let top =
        side === "top"
          ? trigger.top - overlay.height - gap
          : side === "right"
            ? trigger.top
            : trigger.bottom + gap;
      if (side === "right") left = trigger.right + gap;
      left = Math.max(8, Math.min(left, window.innerWidth - overlay.width - 8));
      top = Math.max(8, Math.min(top, window.innerHeight - overlay.height - 8));
      const actual =
        side === "right"
          ? "right-start"
          : align === "center"
            ? side
            : `${side}-${align}`;
      setPosition({
        style: {
          position: "fixed",
          margin: 0,
          right: "auto",
          bottom: "auto",
          left,
          top,
        },
        placement: actual,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlayRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [opts.open, opts.offset, placement, triggerRef, overlayRef]);
  return position;
}
