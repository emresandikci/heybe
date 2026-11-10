import { useState, type ReactNode } from "react";
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

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
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
