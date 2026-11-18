import { useRef, useState } from "react";
import { Button } from "./Button.js";
import { useFieldIds, type FieldProps } from "./field.js";
import { FieldShell } from "./FieldShell.js";

export type FileFieldProps = FieldProps & {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  name?: string;
  onChange: (files: File[]) => void;
};

export function FileField({
  label,
  error,
  hint,
  accept,
  multiple,
  disabled,
  name,
  onChange,
}: FileFieldProps) {
  const ids = useFieldIds({ error, hint });
  const input = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const pick = (files: File[]) => {
    if (files.length === 0) return;
    setNames(files.map((f) => f.name));
    onChange(files);
  };

  return (
    <FieldShell {...ids} label={label} error={error} hint={hint}>
      <div
        data-testid="file-drop"
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const files = [...e.dataTransfer.files];
          pick(multiple ? files : files.slice(0, 1));
        }}
        className={`flex items-center gap-3 rounded-control border border-dashed bg-surface p-3 text-sm has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-focus ${dragging ? "border-accent" : "border-field-line"} ${disabled ? "opacity-50" : ""}`}
      >
        <input
          ref={input}
          type="file"
          name={name}
          accept={accept}
          multiple={multiple}
          disabled={disabled}
          {...ids.aria}
          className="sr-only"
          onChange={(e) => {
            pick([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <Button
          tabIndex={-1}
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {multiple ? "Choose files" : "Choose file"}
        </Button>
        <span className="min-w-0 truncate text-muted">
          {names.length > 0 ? names.join(", ") : "or drop here"}
        </span>
      </div>
    </FieldShell>
  );
}
