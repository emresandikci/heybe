import { Button, TextField } from "@heybe/ui";

export function DateInput({
  name,
  value,
  error,
  disabled,
  onChange,
}: {
  name: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <TextField
          label={`${name} (UTC)`}
          type="datetime-local"
          step={1}
          value={value}
          error={error}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <Button disabled={disabled} onClick={() => onChange("")}>
        Clear
      </Button>
    </div>
  );
}
