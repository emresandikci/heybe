import { useEffect, useLayoutEffect, useRef } from "react";
import { useFieldError } from "../../app/errors";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { CodeArea } from "../../ui/CodeArea";

export function RuleInput({
  label,
  value,
  onChange,
  chips,
  errorPath,
  emptyHint = "Empty rule: everyone, guests included.",
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  chips: string[];
  errorPath: string;
  emptyHint?: string;
}) {
  const error = useFieldError(errorPath);
  const area = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef<number | null>(null);
  const last = useRef(value ?? "");

  useEffect(() => {
    if (value !== null) last.current = value;
  }, [value]);

  useLayoutEffect(() => {
    const el = area.current;
    if (cursor.current === null || !el) return;
    el.focus();
    el.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
  }, [value]);

  const insert = (chip: string) => {
    const text = value ?? "";
    const start = area.current?.selectionStart ?? text.length;
    const end = area.current?.selectionEnd ?? text.length;
    cursor.current = start + chip.length;
    onChange(text.slice(0, start) + chip + text.slice(end));
  };

  return (
    <fieldset className="flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700">
      <legend className="sr-only">{label}</legend>
      <CodeArea
        ref={area}
        label={label}
        rows={3}
        value={value ?? ""}
        disabled={value === null}
        error={error}
        hint={
          value === null
            ? "Only superusers can do this."
            : value === ""
              ? emptyHint
              : undefined
        }
        onChange={onChange}
      />
      <Checkbox
        label="Superusers only"
        checked={value === null}
        onChange={(e) => onChange(e.target.checked ? null : last.current)}
      />
      {value !== null && (
        <>
          <div className="flex flex-wrap gap-1">
            {chips.map((chip) => (
              <Button
                key={chip}
                variant="ghost"
                className="font-mono text-xs"
                onClick={() => insert(chip)}
              >
                {chip}
              </Button>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
