import { useState, type ChangeEvent, type InputHTMLAttributes } from "react";
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
  autoComplete,
}: {
  path: string;
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <TextField
      label={label}
      hint={hint}
      type={type}
      autoComplete={autoComplete}
      value={value}
      error={useFieldError(path)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function useIntText(value: number, onChange: (value: number) => void) {
  const [text, setText] = useState(String(value));
  return {
    value: Number(text) === value ? text : String(value),
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      setText(e.target.value);
      onChange(Math.trunc(Number(e.target.value)));
    },
  };
}

export function IntInput({
  value,
  onChange,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: number;
  onChange(value: number): void;
}) {
  return (
    <input type="number" step={1} {...rest} {...useIntText(value, onChange)} />
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
      step={1}
      error={useFieldError(path)}
      {...useIntText(value, onChange)}
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

export function SecretInput({
  path,
  label,
  value,
  onChange,
}: {
  path: string;
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextInput
      path={path}
      label={label}
      type="password"
      autoComplete="new-password"
      hint="Leave empty to keep the current value"
      value={value}
      onChange={onChange}
    />
  );
}
