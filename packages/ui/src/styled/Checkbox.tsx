import type { InputHTMLAttributes } from "react";
import { FieldMessages } from "./FieldShell.js";
import { useFieldIds, type FieldProps } from "./field.js";

export function Checkbox({
  label,
  error,
  hint,
  hideLabel,
  ...rest
}: FieldProps &
  Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
    hideLabel?: boolean;
  }) {
  const { id, errorId, hintId, aria } = useFieldIds({ error, hint });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          {...rest}
          {...aria}
          className="size-4 shrink-0 appearance-none rounded-[4px] border border-field-line bg-field bg-center bg-no-repeat checked:border-accent checked:bg-accent checked:bg-[url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2016%2016%27%20fill=%27none%27%20stroke=%27white%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27M3.5%208.5l3%203%206-7%27/%3E%3C/svg%3E)] forced-colors:appearance-auto disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:outline-2 aria-[invalid=true]:outline-danger"
        />
        <label
          htmlFor={id}
          className={hideLabel ? "sr-only" : "text-sm text-text"}
        >
          {label}
        </label>
      </div>
      <FieldMessages
        errorId={errorId}
        hintId={hintId}
        error={error}
        hint={hint}
      />
    </div>
  );
}
