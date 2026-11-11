import { useState, type ChangeEvent, type InputHTMLAttributes } from "react";
import { useErrorsUnder, useFieldError } from "../app/errors";
import { Checkbox } from "../ui/Checkbox";
import { CodeArea } from "../ui/CodeArea";
import { NumberField } from "../ui/NumberField";
import { TextField } from "../ui/TextField";

export interface FieldLike<T> {
  state: { value: T };
  handleChange(value: T): void;
}

export function TextInput({
  path,
  label,
  field,
  hint,
  type,
  autoComplete,
}: {
  path: string;
  label: string;
  field: FieldLike<string>;
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
      value={field.state.value}
      error={useFieldError(path)}
      onChange={(e) => field.handleChange(e.target.value)}
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
  field,
}: {
  path: string;
  label: string;
  field: FieldLike<number>;
}) {
  return (
    <NumberField
      label={label}
      step={1}
      error={useFieldError(path)}
      {...useIntText(field.state.value, field.handleChange)}
    />
  );
}

export function CheckInput({
  path,
  label,
  field,
}: {
  path: string;
  label: string;
  field: FieldLike<boolean>;
}) {
  return (
    <Checkbox
      label={label}
      checked={field.state.value}
      error={useFieldError(path)}
      onChange={(e) => field.handleChange(e.target.checked)}
    />
  );
}

export function LinesInput({
  path,
  label,
  field,
  hint,
}: {
  path: string;
  label: string;
  field: FieldLike<string[]>;
  hint?: string;
}) {
  const [text, setText] = useState(() => field.state.value.join("\n"));
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
        field.handleChange(
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
  field,
}: {
  path: string;
  label: string;
  field: FieldLike<string>;
}) {
  return (
    <TextInput
      path={path}
      label={label}
      type="password"
      autoComplete="new-password"
      hint="Leave empty to keep the current value"
      field={field}
    />
  );
}
