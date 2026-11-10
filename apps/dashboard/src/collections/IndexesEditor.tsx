import { useId, useState } from "react";
import { useFieldError } from "../app/errors";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { CodeArea } from "../ui/CodeArea";
import { Dialog } from "../ui/Dialog";
import {
  activeFields,
  finalIndexes,
  type CollectionDraft,
} from "./editor-state";
import { buildIndex, parseIndex, randomIndexName } from "./index-sql";

export function IndexesEditor({
  draft,
  onChange,
}: {
  draft: CollectionDraft;
  onChange: (indexes: string[]) => void;
}) {
  const headingId = useId();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const indexes = finalIndexes(draft);
  const save = (sql: string) => {
    onChange(
      editing === "new"
        ? [...indexes, sql]
        : indexes.map((s, i) => (i === editing ? sql : s)),
    );
    setEditing(null);
  };
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-medium">
        Indexes
      </h3>
      <ul className="flex flex-col gap-2">
        {indexes.map((sql, i) => (
          <IndexRow
            key={i}
            sql={sql}
            errorPath={`indexes.${i}`}
            onEdit={() => setEditing(i)}
            onRemove={() => onChange(indexes.filter((_, j) => j !== i))}
          />
        ))}
      </ul>
      <Button className="self-start" onClick={() => setEditing("new")}>
        Add index
      </Button>
      {editing !== null && (
        <IndexDialog
          table={draft.name}
          columns={activeFields(draft)
            .map((f) => f.name)
            .filter(Boolean)}
          sql={editing === "new" ? null : indexes[editing]!}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </section>
  );
}

function IndexRow({
  sql,
  errorPath,
  onEdit,
  onRemove,
}: {
  sql: string;
  errorPath: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const error = useFieldError(errorPath);
  const parsed = parseIndex(sql);
  return (
    <li className="flex flex-col gap-1 rounded border border-slate-200 p-2 dark:border-slate-700">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono text-xs" title={sql}>
          {parsed
            ? `${parsed.unique ? "Unique: " : ""}${parsed.columns.join(", ")}`
            : sql}
        </span>
        <Button variant="ghost" onClick={onEdit}>
          Edit index
        </Button>
        <Button variant="ghost" onClick={onRemove}>
          Remove index
        </Button>
      </div>
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </li>
  );
}

function IndexDialog({
  table,
  columns,
  sql,
  onCancel,
  onSave,
}: {
  table: string;
  columns: string[];
  sql: string | null;
  onCancel: () => void;
  onSave: (sql: string) => void;
}) {
  const [text, setText] = useState(sql ?? "");
  const [uniqueChoice, setUniqueChoice] = useState(false);
  const [newName] = useState(randomIndexName);
  const parsed = parseIndex(text);
  const editable = text.trim() === "" || !!parsed?.simple;
  const selected = parsed?.columns ?? [];
  const unique = parsed?.unique ?? uniqueChoice;
  const name = parsed?.name ?? newName;

  const rebuild = (nextColumns: string[], nextUnique: boolean) => {
    setUniqueChoice(nextUnique);
    setText(
      nextColumns.length
        ? buildIndex({ table, columns: nextColumns, unique: nextUnique, name })
        : "",
    );
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={sql ? "Edit index" : "Add index"}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={text.trim() === ""}
            onClick={() => onSave(text.trim())}
          >
            Save index
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-3">
          <legend className="mb-1 text-sm font-medium">Columns</legend>
          {columns.map((column) => (
            <Checkbox
              key={column}
              label={column}
              disabled={!editable}
              checked={selected.includes(column)}
              onChange={(e) =>
                rebuild(
                  e.target.checked
                    ? [...selected, column]
                    : selected.filter((c) => c !== column),
                  unique,
                )
              }
            />
          ))}
        </fieldset>
        <Checkbox
          label="Unique"
          disabled={!editable}
          hint={
            editable
              ? undefined
              : "This index uses SQL the checkboxes cannot show. Edit the SQL instead."
          }
          checked={unique}
          onChange={(e) => rebuild(selected, e.target.checked)}
        />
        <CodeArea label="Index SQL" rows={4} value={text} onChange={setText} />
      </div>
    </Dialog>
  );
}
