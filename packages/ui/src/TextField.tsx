import type { InputHTMLAttributes } from "react";
import { inputClass, useFieldIds, type FieldProps } from "./field.js";
import { FieldShell } from "./FieldShell.js";

export function TextField({
  label,
  error,
  hint,
  className,
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds({ error, hint });
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint}>
      <input
        type="text"
        {...rest}
        {...ids.aria}
        className={`${inputClass} ${className ?? ""}`}
      />
    </FieldShell>
  );
}
