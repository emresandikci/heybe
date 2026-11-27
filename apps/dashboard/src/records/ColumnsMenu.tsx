import { Button, Checkbox, Popover } from "@heybejs/ui";

export function ColumnsMenu({
  names,
  hidden,
  onToggle,
}: {
  names: string[];
  hidden: string[];
  onToggle: (name: string) => void;
}) {
  return (
    <Popover trigger={<Button>Columns</Button>} placement="bottom-end">
      <div className="flex flex-col gap-1">
        {names.map((name) => (
          <Checkbox
            key={name}
            label={name}
            checked={!hidden.includes(name)}
            onChange={() => onToggle(name)}
          />
        ))}
      </div>
    </Popover>
  );
}
