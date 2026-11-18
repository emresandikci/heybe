import { useId } from "react";
import { Checkbox, Select } from "@heybe/ui";

export function SelectInput({
  name,
  options,
  multiple,
  value,
  error,
  disabled,
  onChange,
}: {
  name: string;
  options: string[];
  multiple: boolean;
  value: string | string[];
  error?: string;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const errorId = useId();
  if (!multiple)
    return (
      <Select
        label={name}
        value={value as string}
        error={error}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value=""></option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  const chosen = value as string[];
  return (
    <fieldset
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      className="flex flex-col gap-1"
    >
      <legend className="text-sm font-medium">{name}</legend>
      {options.map((o) => (
        <Checkbox
          key={o}
          label={o}
          checked={chosen.includes(o)}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.checked
                ? options.filter((x) => x === o || chosen.includes(x))
                : chosen.filter((x) => x !== o),
            )
          }
        />
      ))}
      {error && (
        <p id={errorId} className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </fieldset>
  );
}
