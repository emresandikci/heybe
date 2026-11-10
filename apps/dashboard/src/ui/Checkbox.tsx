import type { InputHTMLAttributes } from "react";
import { useFieldIds, type FieldProps } from "./field";

export function Checkbox({
  label,
  error,
  hint,
  ...rest
}: FieldProps & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const { id, errorId, hintId, aria } = useFieldIds({ error, hint });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input type="checkbox" {...rest} {...aria} />
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
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
