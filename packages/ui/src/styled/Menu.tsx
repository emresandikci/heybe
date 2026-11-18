import type { ComponentProps } from "react";
import { Menu as MenuPrimitive } from "../primitives/Menu.js";
import { glass } from "./glass.js";
import { tv } from "./tv.js";

export type { MenuItem } from "../primitives/Menu.js";

const menu = tv({
  base: [
    glass,
    "z-50 min-w-44 rounded-base p-1 text-sm text-text outline-none",
    "[&_[role^=menuitem]]:flex [&_[role^=menuitem]]:cursor-default [&_[role^=menuitem]]:items-center [&_[role^=menuitem]]:gap-2 [&_[role^=menuitem]]:rounded-control [&_[role^=menuitem]]:px-2.5 [&_[role^=menuitem]]:py-1.5 [&_[role^=menuitem]]:outline-none",
    "[&_[role^=menuitem]>span]:flex-1 [&_kbd]:font-sans [&_kbd]:text-xs [&_kbd]:text-faint",
    "[&_[data-active]]:bg-hover [&_[data-disabled]]:opacity-50",
    "[&_[data-danger]]:text-danger-text [&_[data-danger][data-active]]:bg-danger/10",
    "[&_[data-heading]]:px-2.5 [&_[data-heading]]:py-1 [&_[data-heading]]:text-xs [&_[data-heading]]:font-medium [&_[data-heading]]:text-faint",
    "[&_[role=separator]]:my-1 [&_[role=separator]]:h-px [&_[role=separator]]:bg-line",
  ],
});

export function Menu({
  className,
  ...rest
}: ComponentProps<typeof MenuPrimitive>) {
  return <MenuPrimitive {...rest} className={menu({ className })} />;
}
