import type { ReactNode } from "react";

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center text-slate-500">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}
