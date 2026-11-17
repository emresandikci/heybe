import { useEffect, useRef } from "react";
import { useFieldError } from "../../app/errors";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { CodeArea, type CodeAreaHandle } from "../../ui/CodeArea";

export function RuleInput({
  label,
  value,
  onChange,
  chips,
  errorPath,
  emptyHint = "Empty rule: everyone, guests included.",
  lockable = true,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  chips: string[];
  errorPath: string;
  emptyHint?: string;
  lockable?: boolean;
}) {
  const error = useFieldError(errorPath);
  const area = useRef<CodeAreaHandle>(null);
  const last = useRef(value ?? "");

  useEffect(() => {
    if (value !== null) last.current = value;
  }, [value]);

  const insert = (chip: string) => area.current?.insert(chip);

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
      {lockable && (
        <Checkbox
          label="Superusers only"
          checked={value === null}
          onChange={(e) => onChange(e.target.checked ? null : last.current)}
        />
      )}
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
