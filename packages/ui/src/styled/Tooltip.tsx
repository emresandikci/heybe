import type { ComponentProps } from "react";
import { Tooltip as TooltipPrimitive } from "../primitives/Tooltip.js";
import { glass } from "./glass.js";
import { tv } from "./tv.js";

const tooltip = tv({
  base: `${glass} z-50 rounded-control px-2 py-1 text-xs text-text`,
});

export function Tooltip({
  className,
  ...rest
}: ComponentProps<typeof TooltipPrimitive>) {
  return <TooltipPrimitive {...rest} className={tooltip({ className })} />;
}
