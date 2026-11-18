import type { ReactNode } from "react";
import type { FieldProps } from "./field.js";

export function FieldMessages({
  errorId,
  hintId,
  error,
  hint,
}: Pick<FieldProps, "error" | "hint"> & { errorId: string; hintId: string }) {
  return (
    <>
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </>
  );
}

export function FieldShell({
  id,
  errorId,
  hintId,
  label,
  error,
  hint,
  hideLabel,
  children,
}: FieldProps & {
  hideLabel?: boolean;
  id: string;
  errorId: string;
  hintId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className={hideLabel ? "sr-only" : "text-sm font-medium text-text"}
      >
        {label}
      </label>
      {children}
      <FieldMessages
        errorId={errorId}
        hintId={hintId}
        error={error}
        hint={hint}
      />
    </div>
  );
}
