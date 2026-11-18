import type { ReactNode } from "react";

const tones = {
  neutral: "bg-hover text-muted",
  success: "bg-success/15 text-success-text",
  danger: "bg-danger/15 text-danger-text",
  warning: "border border-warning-line bg-warning-bg text-warning-text",
};

export function Badge({
  tone,
  children,
}: {
  tone: keyof typeof tones;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
