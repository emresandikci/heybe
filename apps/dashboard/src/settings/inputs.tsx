import { useState } from "react";
import { useErrorsUnder, useFieldError } from "../app/errors";
import { Checkbox } from "../ui/Checkbox";
import { CodeArea } from "../ui/CodeArea";
import { NumberField } from "../ui/NumberField";
import { TextField } from "../ui/TextField";

export function TextInput({
  path,
  label,
  value,
  onChange,
  hint,
  type,
}: {
  path: string;
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  type?: string;
}) {
  return (
    <TextField
      label={label}
      hint={hint}
      type={type}
      value={value}
      error={useFieldError(path)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function NumberInput({
  path,
  label,
  value,
  onChange,
}: {
  path: string;
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <NumberField
      label={label}
      value={value}
      step={1}
      error={useFieldError(path)}
      onChange={(e) => onChange(Math.trunc(Number(e.target.value)))}
    />
  );
}

export function CheckInput({
  path,
  label,
  checked,
  onChange,
}: {
  path: string;
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <Checkbox
      label={label}
      checked={checked}
      error={useFieldError(path)}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function LinesInput({
  path,
  label,
  value,
  onChange,
  hint,
}: {
  path: string;
  label: string;
  value: string[];
  onChange(value: string[]): void;
  hint?: string;
}) {
  const [text, setText] = useState(() => value.join("\n"));
  const own = useFieldError(path);
  const lineErrors = useErrorsUnder(`${path}.`).map(
    ([key, message]) =>
      `Line ${Number(key.slice(path.length + 1).split(".")[0]) + 1}: ${message}`,
  );
  const error = [own, ...lineErrors].filter(Boolean).join(" ") || undefined;
  return (
    <CodeArea
      label={label}
      hint={hint}
      rows={3}
      value={text}
      error={error}
      onChange={(next) => {
        setText(next);
        onChange(
          next
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
