import type { ButtonHTMLAttributes, ReactNode } from "react";
import { tv } from "./tv.js";

const button = tv({
  base: "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium transition-colors duration-[var(--hb-duration)] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50",
  variants: {
    variant: {
      primary: "bg-accent text-accent-fg enabled:hover:bg-accent-hover",
      secondary:
        "border border-line bg-surface text-text enabled:hover:bg-hover",
      danger: "bg-danger text-danger-fg enabled:hover:bg-danger-hover",
      ghost: "text-text enabled:hover:bg-hover",
    },
    size: {
      sm: "h-7 px-2.5 text-xs",
      md: "h-9 px-4 text-sm",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export function Button({
  variant,
  size,
  icon,
  loading,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  icon?: ReactNode;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-size={size ?? "md"}
      className={button({ variant, size, className })}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
