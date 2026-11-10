import { forwardRef, type KeyboardEvent } from "react";
import { inputClass, useFieldIds, type FieldProps } from "./field";
import { FieldShell } from "./FieldShell";

interface CodeAreaProps extends FieldProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  onRun?: () => void;
}

export const CodeArea = forwardRef<HTMLTextAreaElement, CodeAreaProps>(
  function CodeArea(
    { label, value, onChange, error, hint, rows = 6, onRun },
    ref,
  ) {
    const ids = useFieldIds({ error, hint });
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (onRun && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onRun();
      }
    };
    return (
      <FieldShell {...ids} label={label} error={error} hint={hint}>
        <textarea
          ref={ref}
          {...ids.aria}
          rows={rows}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={`${inputClass} font-mono`}
        />
      </FieldShell>
    );
  },
);
