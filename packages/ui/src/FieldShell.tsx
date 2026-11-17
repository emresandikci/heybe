import type { ReactNode } from "react";
import type { FieldProps } from "./field.js";

export function FieldShell({
  id,
  errorId,
  hintId,
  label,
  error,
  hint,
  children,
}: FieldProps & {
  id: string;
  errorId: string;
  hintId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={hintId} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
