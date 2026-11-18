import type { ComponentProps } from "react";
import { Combobox as ComboboxPrimitive } from "../primitives/Combobox.js";
import { glass } from "./glass.js";
import { inputClass } from "./field.js";
import { tv } from "./tv.js";

export type { ComboboxOption } from "../primitives/Combobox.js";

const input = tv({ base: inputClass });
const list = tv({
  base: [
    glass,
    "z-50 rounded-base p-1 text-sm text-text",
    "[&_[role=option]]:cursor-default [&_[role=option]]:rounded-control [&_[role=option]]:px-2.5 [&_[role=option]]:py-1.5",
    "[&_[data-active]]:bg-hover [&_[aria-selected=true]]:text-accent-text [&_[aria-disabled=true]]:opacity-50",
    "[&_[data-empty]]:px-2.5 [&_[data-empty]]:py-1.5 [&_[data-empty]]:text-muted",
  ],
});

export function Combobox({
  className,
  listClassName,
  ...rest
}: ComponentProps<typeof ComboboxPrimitive>) {
  return (
    <div className="flex flex-col gap-1.5 [&>label]:text-sm [&>label]:font-medium [&>label]:text-text">
      <ComboboxPrimitive
        {...rest}
        className={input({ className })}
        listClassName={list({ className: listClassName })}
      />
    </div>
  );
}
