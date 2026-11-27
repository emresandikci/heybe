import {
  useState,
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useErrorsUnder, useFieldError } from "../app/errors";
import {
  Badge,
  Checkbox,
  Disclosure,
  NumberField,
  Switch,
  TextField,
} from "@heybejs/ui";

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
}: Omit<ComponentProps<typeof NumberField>, "value" | "onChange"> & {
  value: number;
  onChange(value: number): void;
}) {
  return <NumberField step={1} {...rest} {...useIntText(value, onChange)} />;
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
    <IntInput
      label={label}
      error={useFieldError(path)}
      value={field.state.value}
      onChange={field.handleChange}
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

export function SwitchInput({
  path,
  label,
  field,
}: {
  path: string;
  label: string;
  field: FieldLike<boolean>;
}) {
  return (
    <Switch
      label={label}
      checked={field.state.value}
      error={useFieldError(path)}
      onChange={field.handleChange}
    />
  );
}

const parseList = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const sameList = (a: string[], b: string[]) => a.join("\n") === b.join("\n");

export function ListInput({
  path,
  label,
  field,
  hint,
  disabled,
}: {
  path: string;
  label: string;
  field: FieldLike<string[]>;
  hint?: string;
  disabled?: boolean;
}) {
  const [typed, setText] = useState(() => field.state.value.join(", "));
  const text = sameList(parseList(typed), field.state.value)
    ? typed
    : field.state.value.join(", ");
  const own = useFieldError(path);
  const itemErrors = useErrorsUnder(`${path}.`).map(
    ([key, message]) =>
      `Item ${Number(key.slice(path.length + 1).split(".")[0]) + 1}: ${message}`,
  );
  const error = [own, ...itemErrors].filter(Boolean).join(" ") || undefined;
  return (
    <TextField
      label={label}
      hint={
        hint
          ? `${hint} Separate entries with commas.`
          : "Separate entries with commas."
      }
      disabled={disabled}
      value={text}
      error={error}
      onChange={(e) => {
        setText(e.target.value);
        field.handleChange(parseList(e.target.value));
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

export function DependentFields({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset
      disabled={!enabled}
      className="flex min-w-0 flex-col gap-3 transition-opacity disabled:opacity-60"
    >
      {children}
    </fieldset>
  );
}

export function EnabledBadge({ on }: { on: boolean }) {
  return (
    <Badge tone={on ? "success" : "neutral"}>
      {on ? "Enabled" : "Disabled"}
    </Badge>
  );
}

export function SectionDisclosure({
  errorPrefix,
  defaultOpen,
  ...props
}: Omit<ComponentProps<typeof Disclosure>, "open" | "onOpenChange"> & {
  errorPrefix: string;
}) {
  const failed = useErrorsUnder(errorPrefix, false).length > 0;
  const [open, setOpen] = useState(!!defaultOpen || failed);
  const [wasFailed, setWasFailed] = useState(failed);
  if (failed !== wasFailed) {
    setWasFailed(failed);
    if (failed) setOpen(true);
  }
  return <Disclosure {...props} open={open} onOpenChange={setOpen} />;
}
