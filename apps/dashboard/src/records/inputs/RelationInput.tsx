import { useId, useState } from "react";
import { useCollections } from "../../app/queries";
import { X } from "lucide-react";
import { Button } from "@heybejs/ui";
import { expandedRecords, presentableLabel, type CellField } from "../cell";
import { isMulti } from "../record-form";
import { RelationPicker } from "../RelationPicker";

type Rec = Record<string, unknown>;

export function RelationInput({
  field,
  name,
  value,
  record,
  error,
  disabled,
  onChange,
}: {
  field: CellField;
  name: string;
  value: string | string[];
  record?: Rec;
  error?: string;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const collections = useCollections();
  const target = collections.data?.find((c) => c.id === field.collectionId);
  const multi = isMulti(field);
  const ids = Array.isArray(value) ? value : value ? [value] : [];
  const [known, setKnown] = useState(
    () =>
      (record ? expandedRecords(record, field.name) : new Map()) as Map<
        string,
        Rec
      >,
  );
  const [picking, setPicking] = useState(false);
  const errorId = useId();

  const set = (next: string[]) => onChange(multi ? next : (next[0] ?? ""));

  return (
    <fieldset
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      className="flex flex-col gap-2"
    >
      <legend className="text-sm font-medium">{name}</legend>
      <ul className="flex flex-wrap gap-2">
        {ids.map((id) => {
          const label = presentableLabel(target, known.get(id), id);
          return (
            <li
              key={id}
              className="flex items-center gap-1 rounded-control border border-line bg-field py-0.5 pl-2.5 pr-1 text-sm"
            >
              <span>{label}</span>
              <button
                type="button"
                disabled={disabled}
                aria-label={`Remove ${label}`}
                onClick={() => set(ids.filter((x) => x !== id))}
                className="inline-flex size-5 items-center justify-center rounded-control text-muted hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
              >
                <X size={13} strokeWidth={1.75} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <Button
        className="self-start"
        disabled={disabled || !target}
        onClick={() => setPicking(true)}
      >
        Choose records
      </Button>
      {error && (
        <p id={errorId} className="text-xs text-danger-text">
          {error}
        </p>
      )}
      {picking && target && (
        <RelationPicker
          title={`Choose ${name}`}
          target={target}
          selected={ids}
          known={known}
          maxSelect={multi ? Number(field.maxSelect) : 1}
          onClose={() => setPicking(false)}
          onSelect={(records) => {
            setKnown((prev) => {
              const next = new Map(prev);
              records.forEach((r) => next.set(r.id as string, r));
              return next;
            });
            set(records.map((r) => r.id as string));
            setPicking(false);
          }}
        />
      )}
    </fieldset>
  );
}
