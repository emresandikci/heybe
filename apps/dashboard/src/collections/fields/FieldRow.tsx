import { useEffect, useState } from "react";
import { useErrorsUnder, useFieldError } from "../../app/errors";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { TextField } from "../../ui/TextField";
import type { FieldModel } from "../editor-state";
import { fieldTypeLabel } from "../field-types";
import { FieldOptions } from "./FieldOptions";

export interface FieldRowProps {
  field: FieldModel;
  errorPath: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (patch: Partial<FieldModel>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onRestore: () => void;
}

const rowClass =
  "flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700";

export function FieldRow(props: FieldRowProps) {
  const { field } = props;
  if (field._removed)
    return (
      <fieldset aria-label={field.name} className={`${rowClass} opacity-60`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm line-through">{field.name}</span>
          <Button onClick={props.onRestore}>Restore</Button>
        </div>
      </fieldset>
    );
  return <ActiveRow {...props} />;
}

function ActiveRow({
  field,
  errorPath,
  canMoveUp,
  canMoveDown,
  onChange,
  onMove,
  onRemove,
}: FieldRowProps) {
  const nameError = useFieldError(`${errorPath}.name`);
  const [open, setOpen] = useState(!field.id);
  const optionErrors = useErrorsUnder(`${errorPath}.`, false).filter(
    ([path]) => path !== `${errorPath}.name`,
  );
  const hasOptionErrors = optionErrors.length > 0;
  useEffect(() => {
    if (hasOptionErrors) setOpen(true);
  }, [hasOptionErrors]);
  return (
    <fieldset aria-label={field.name || "New field"} className={rowClass}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <TextField
            label="Field name"
            value={field.name}
            disabled={field.system}
            error={nameError}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <span className="pt-7 text-xs text-slate-500 dark:text-slate-400">
          {fieldTypeLabel(field.type)}
          {field.system && " (system)"}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {field.type !== "autodate" && (
          <Checkbox
            label="Required"
            checked={!!field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
        )}
        <Checkbox
          label="Hidden"
          checked={field.hidden}
          onChange={(e) => onChange({ hidden: e.target.checked })}
        />
        <Checkbox
          label="Presentable"
          checked={field.presentable}
          onChange={(e) => onChange({ presentable: e.target.checked })}
        />
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            Options
          </Button>
          <Button
            variant="ghost"
            aria-label="Move up"
            disabled={!canMoveUp}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            aria-label="Move down"
            disabled={!canMoveDown}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          {!field.system && (
            <Button variant="ghost" onClick={onRemove}>
              Remove field
            </Button>
          )}
        </div>
      </div>
      {open && (
        <FieldOptions field={field} errorPath={errorPath} onChange={onChange} />
      )}
    </fieldset>
  );
}
