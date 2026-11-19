import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { Dialog as DialogPrimitive } from "../primitives/Dialog.js";
import { tv } from "./tv.js";

const dialog = tv({
  base: [
    "border border-line bg-raised p-0 text-text shadow-overlay backdrop:bg-scrim",
    "[&_[data-part=content]]:flex [&_[data-part=content]]:max-h-dvh [&_[data-part=content]]:flex-col",
    "[&_[data-part=header]]:flex [&_[data-part=header]]:items-center [&_[data-part=header]]:justify-between [&_[data-part=header]]:gap-2 [&_[data-part=header]]:border-b [&_[data-part=header]]:border-line [&_[data-part=header]]:py-3 [&_[data-part=header]]:pl-4 [&_[data-part=header]]:pr-3",
    "[&_[data-part=title]]:text-base [&_[data-part=title]]:font-semibold",
    "[&_[data-part=close]]:inline-flex [&_[data-part=close]]:size-8 [&_[data-part=close]]:items-center [&_[data-part=close]]:justify-center [&_[data-part=close]]:rounded-control [&_[data-part=close]]:text-muted [&_[data-part=close]:hover]:bg-hover [&_[data-part=close]:hover]:text-text [&_[data-part=close]:focus-visible]:outline-2 [&_[data-part=close]:focus-visible]:outline-focus",
    "[&_[data-part=body]]:flex-1 [&_[data-part=body]]:overflow-auto [&_[data-part=body]]:p-4",
    "[&_[data-part=footer]]:flex [&_[data-part=footer]]:flex-wrap [&_[data-part=footer]]:justify-end [&_[data-part=footer]]:gap-2 [&_[data-part=footer]]:border-t [&_[data-part=footer]]:border-line [&_[data-part=footer]]:p-4",
  ],
  variants: {
    variant: {
      center: "m-auto w-full max-w-lg rounded-base",
      side: "ml-auto h-dvh max-h-dvh w-full max-w-xl [&_[data-part=content]]:h-full",
    },
    size: { md: "", lg: "" },
  },
  compoundVariants: [{ variant: "center", size: "lg", class: "max-w-3xl" }],
  defaultVariants: { variant: "center", size: "md" },
});

export function Dialog({
  variant,
  size,
  ...rest
}: Omit<ComponentProps<typeof DialogPrimitive>, "className"> & {
  variant?: "center" | "side";
  size?: "md" | "lg";
}) {
  return (
    <DialogPrimitive
      {...rest}
      closeIcon={<X size={15} strokeWidth={1.75} aria-hidden />}
      className={dialog({ variant, size })}
    />
  );
}
