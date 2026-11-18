import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "../primitives/Switch.js";
import { useFieldIds, type FieldProps } from "./field.js";
import { FieldMessages } from "./FieldShell.js";

export function Switch({
  label,
  error,
  hint,
  ...rest
}: FieldProps & Omit<ComponentProps<typeof SwitchPrimitive>, "className">) {
  const { errorId, hintId, aria } = useFieldIds({ error, hint });
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <SwitchPrimitive
          {...rest}
          label={label}
          aria-describedby={aria["aria-describedby"]}
          aria-invalid={aria["aria-invalid"]}
          className="relative h-5 w-9 shrink-0 rounded-full bg-control transition-colors duration-[var(--hb-duration)] motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus aria-[invalid=true]:outline-2 aria-[invalid=true]:outline-danger disabled:opacity-50 data-[checked]:bg-accent [&>span]:absolute [&>span]:top-0.5 [&>span]:left-0.5 [&>span]:size-4 [&>span]:rounded-full [&>span]:bg-thumb [&>span]:transition-transform [&>span]:duration-[var(--hb-duration)] motion-reduce:[&>span]:transition-none data-[checked]:[&>span]:translate-x-4"
        />
        <span className="text-sm text-text">{label}</span>
      </label>
      <FieldMessages
        errorId={errorId}
        hintId={hintId}
        error={error}
        hint={hint}
      />
    </div>
  );
}
