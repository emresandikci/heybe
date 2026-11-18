import { useEffect, useRef } from "react";
import { useFieldError } from "../../app/errors";
import { chipClass } from "../chip";
import {
  Checkbox,
  CodeArea,
  type CodeAreaHandle,
  type CodeSuggest,
} from "@heybe/ui";

export function RuleInput({
  label,
  value,
  onChange,
  chips,
  suggest,
  errorPath,
  emptyHint = "Empty rule: everyone, guests included.",
  lockable = true,
}: {
  label: string;
  value: string | null;
  onChange: (value: string | null) => void;
  chips: string[];
  suggest: CodeSuggest;
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
    <fieldset className="flex flex-col gap-2 rounded border border-line p-3 dark:border-line">
      <legend className="sr-only">{label}</legend>
      <CodeArea
        ref={area}
        label={label}
        rows={3}
        suggest={suggest}
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
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                className={`${chipClass} font-mono`}
                onClick={() => insert(chip)}
              >
                {chip}
              </button>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
