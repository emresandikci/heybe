import { useEffect, useState } from "react";
import { useErrorsUnder, useFieldError } from "../../app/errors";
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Braces,
  Calendar,
  Clock,
  FileText,
  Hash,
  Link,
  Link2,
  List,
  Lock,
  MapPin,
  MoreHorizontal,
  Paperclip,
  ToggleLeft,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";
import { Badge, Button, Checkbox, Menu, TextField } from "@heybe/ui";
import type { FieldModel } from "../editor-state";
import { fieldTypeLabel, type FieldType } from "../field-types";
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

const TYPE_ICONS: Record<FieldType, LucideIcon> = {
  text: Type,
  editor: FileText,
  number: Hash,
  bool: ToggleLeft,
  email: AtSign,
  url: Link,
  date: Calendar,
  autodate: Clock,
  select: List,
  file: Paperclip,
  relation: Link2,
  json: Braces,
  geoPoint: MapPin,
  password: Lock,
};

const rowClass =
  "flex flex-col gap-2 rounded border border-line p-3 dark:border-line";

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
  const Icon = TYPE_ICONS[field.type];
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
      <div className="grid grid-cols-[auto_1fr_9rem_auto] items-center gap-2">
        <Icon size={15} strokeWidth={1.75} aria-hidden className="text-muted" />
        <div className="[&_label]:sr-only">
          <TextField
            label="Field name"
            value={field.name}
            disabled={field.system}
            error={nameError}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <span className="justify-self-end">
          <Badge tone="neutral">
            {fieldTypeLabel(field.type)}
            {field.system && " (system)"}
          </Badge>
        </span>
        <Menu
          trigger={
            <Button
              variant="ghost"
              aria-label={`Actions for ${field.name || "new field"}`}
              icon={<MoreHorizontal size={15} strokeWidth={1.75} />}
              className="w-9 px-0"
            />
          }
          items={[
            {
              key: "up",
              label: "Move up",
              icon: <ArrowUp size={15} strokeWidth={1.75} />,
              disabled: !canMoveUp,
            },
            {
              key: "down",
              label: "Move down",
              icon: <ArrowDown size={15} strokeWidth={1.75} />,
              disabled: !canMoveDown,
            },
            ...(field.system
              ? []
              : [
                  { separator: true as const },
                  {
                    key: "remove",
                    label: "Remove field",
                    icon: <Trash2 size={15} strokeWidth={1.75} />,
                    danger: true,
                  },
                ]),
          ]}
          onAction={(key) =>
            key === "remove" ? onRemove() : onMove(key === "up" ? -1 : 1)
          }
          placement="bottom-start"
        />
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
        <Button
          variant="ghost"
          className="ml-auto"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Options
        </Button>
      </div>
      {open && (
        <FieldOptions field={field} errorPath={errorPath} onChange={onChange} />
      )}
    </fieldset>
  );
}
