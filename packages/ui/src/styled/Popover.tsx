import type { ComponentProps } from "react";
import { Popover as PopoverPrimitive } from "../primitives/Popover.js";
import { glass } from "./glass.js";
import { tv } from "./tv.js";

const popover = tv({
  base: `${glass} z-50 rounded-base p-3 text-sm text-text outline-none`,
});

export function Popover({
  className,
  ...rest
}: ComponentProps<typeof PopoverPrimitive>) {
  return <PopoverPrimitive {...rest} className={popover({ className })} />;
}
