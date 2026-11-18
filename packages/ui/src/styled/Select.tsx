import { ChevronDown } from "lucide-react";
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
      <div className="relative">
        <select
          {...rest}
          {...ids.aria}
          className={`${inputClass} appearance-none pr-8`}
        >
          {children}
        </select>
        <ChevronDown
          size={15}
          strokeWidth={1.75}
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
        />
      </div>
    </FieldShell>
  );
}
