import { X } from "lucide-react";
import { FieldShell, useFieldIds } from "@heybe/ui";

export function DateInput({
  name,
  value,
  error,
  disabled,
  onChange,
}: {
  name: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const ids = useFieldIds({ error });
  return (
    <FieldShell {...ids} label={`${name} (UTC)`} error={error}>
      <div
        className={`flex h-9 items-center rounded-control border bg-field pr-1 focus-within:outline-2 focus-within:outline-focus ${error ? "border-danger" : "border-field-line"} ${disabled ? "opacity-50" : ""}`}
      >
        <input
          {...ids.aria}
          type="datetime-local"
          step={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-text outline-none"
        />
        {value && (
          <button
            type="button"
            aria-label={`Clear ${name}`}
            disabled={disabled}
            onClick={() => onChange("")}
            className="inline-flex size-7 items-center justify-center rounded-control text-muted hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
          >
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
    </FieldShell>
  );
}
