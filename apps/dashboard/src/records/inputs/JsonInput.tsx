import { CodeArea } from "@heybe/ui";

export function JsonInput({
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
    <CodeArea
      label={name}
      language="json"
      value={value}
      error={error}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
