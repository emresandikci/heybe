import { useState } from "react";
import { Button, Checkbox } from "@heybe/ui";

export function ColumnsMenu({
  names,
  hidden,
  onToggle,
}: {
  names: string[];
  hidden: string[];
  onToggle: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button aria-expanded={open} onClick={() => setOpen(!open)}>
        Columns
      </Button>
      {open && (
        <div className="absolute right-0 z-10 flex flex-col gap-1 rounded border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          {names.map((name) => (
            <Checkbox
              key={name}
              label={name}
              checked={!hidden.includes(name)}
              onChange={() => onToggle(name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
