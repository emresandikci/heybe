import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-[var(--accent)] text-white hover:opacity-90",
  secondary:
    "border border-slate-300 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800",
  danger: "bg-red-600 text-white hover:bg-red-700",
  ghost: "hover:bg-slate-100 dark:hover:bg-slate-800",
};

export function Button({
  variant = "secondary",
  loading,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${variants[variant]} ${className ?? ""}`}
      {...rest}
    >
      {children}
    </button>
  );
}
