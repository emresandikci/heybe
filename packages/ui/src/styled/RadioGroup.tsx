import type { ComponentProps } from "react";
import { RadioGroup as RadioGroupPrimitive } from "../primitives/RadioGroup.js";
import { useFieldIds, type FieldProps } from "./field.js";
import { FieldMessages } from "./FieldShell.js";

export function RadioGroup({
  label,
  error,
  hint,
  ...rest
}: FieldProps & Omit<ComponentProps<typeof RadioGroupPrimitive>, "className">) {
  const { errorId, hintId, aria } = useFieldIds({ error, hint });
  const horizontal = rest.orientation === "horizontal";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text">{label}</span>
      <RadioGroupPrimitive
        {...rest}
        label={label}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        className={`flex gap-2 ${horizontal ? "flex-row flex-wrap" : "flex-col"} [&>button]:flex [&>button]:items-center [&>button]:gap-2 [&>button]:text-left [&>button]:text-sm [&>button]:text-text [&>button]:before:size-4 [&>button]:before:rounded-full [&>button]:before:border [&>button]:before:border-control [&>button]:before:bg-surface aria-[invalid=true]:[&>button]:before:border-danger [&>button]:before:content-[''] [&>button[data-checked]]:before:border-[5px] [&>button[data-checked]]:before:border-accent [&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-offset-2 [&>button]:focus-visible:outline-focus [&>button]:disabled:opacity-50`}
      />
      <FieldMessages
        errorId={errorId}
        hintId={hintId}
        error={error}
        hint={hint}
      />
    </div>
  );
}
