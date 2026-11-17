import type { SelectHTMLAttributes } from "react";
import { inputClass, useFieldIds, type FieldProps } from "./field.js";
import { FieldShell } from "./FieldShell.js";

export function Select({
  label,
  error,
  hint,
  children,
  ...rest
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds({ error, hint });
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint}>
      <select {...rest} {...ids.aria} className={inputClass}>
        {children}
      </select>
    </FieldShell>
  );
}
