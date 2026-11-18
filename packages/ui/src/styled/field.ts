import { useId } from "react";

export interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
}

export function useFieldIds({
  error,
  hint,
}: Pick<FieldProps, "error" | "hint">) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") ||
    undefined;
  return {
    id,
    errorId,
    hintId,
    aria: {
      id,
      "aria-invalid": error ? (true as const) : undefined,
      "aria-describedby": describedBy,
    },
  };
}

export const inputClass =
  "h-9 w-full rounded-control border border-field-line bg-field px-2.5 text-sm text-text placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus aria-[invalid=true]:border-danger disabled:opacity-50";
