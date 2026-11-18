import type { ReactNode } from "react";

export function EmptyState({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-8 py-12 text-center text-sm text-muted">
      {icon && (
        <span className="mb-1 flex size-9 items-center justify-center rounded-full bg-hover text-muted">
          {icon}
        </span>
      )}
      <p className="font-medium text-text">{title}</p>
      {children}
    </div>
  );
}
