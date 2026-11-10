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
  "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800";
