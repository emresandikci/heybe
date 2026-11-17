import type { InputHTMLAttributes } from "react";
import { inputClass, useFieldIds, type FieldProps } from "./field.js";
import { FieldShell } from "./FieldShell.js";

export function NumberField({
  label,
  error,
  hint,
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds({ error, hint });
  const describedBy =
    [ids.aria["aria-describedby"], rest["aria-describedby"]]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <FieldShell {...ids} label={label} error={error} hint={hint}>
      <input
        type="number"
        {...rest}
        {...ids.aria}
        aria-invalid={ids.aria["aria-invalid"] ?? rest["aria-invalid"]}
        aria-describedby={describedBy}
        className={inputClass}
      />
    </FieldShell>
  );
}
