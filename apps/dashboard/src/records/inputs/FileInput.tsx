import { useId, useState } from "react";
import { useClient } from "../../app/context";
import { Button } from "../../ui/Button";
import { IMAGE, list, useFileToken, type CellField } from "../cell";
import { FilePreview } from "../FilePreview";
import { isMulti, type FileValue } from "../record-form";

export function FileInput({
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
  value: FileValue;
  record?: Record<string, unknown>;
  error?: string;
  disabled: boolean;
  onChange: (value: FileValue) => void;
}) {
  const client = useClient();
  const token = useFileToken(field);
  const errorId = useId();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const multi = isMulti(field);
  const existing = record ? list(record[field.name]).map(String) : [];
  const kept =
    existing.filter((f) => !value.removed.includes(f)).length +
    value.added.length;
  const full = multi && kept >= Number(field.maxSelect);
  const waiting = !!field.protected && token === undefined;
  const url = (file: string, thumb?: string) =>
    client.files.url(record ?? {}, file, { thumb, token });

  const toggle = (file: string) =>
    onChange({
      ...value,
      removed: value.removed.includes(file)
        ? value.removed.filter((r) => r !== file)
        : [...value.removed, file],
    });

  const pick = (files: File[]) => {
    if (files.length === 0) return;
    onChange({
      ...value,
      added: multi ? [...value.added, ...files] : [files[0]!],
    });
    setInputKey((k) => k + 1);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{name}</legend>
      <ul className="flex flex-col gap-2">
        {existing.map((file) => {
          const removed = value.removed.includes(file);
          return (
            <li key={file} className="flex items-center gap-2">
              <span className={removed ? "line-through opacity-50" : ""}>
                {waiting ? (
                  file
                ) : IMAGE.test(file) ? (
                  <button
                    type="button"
                    aria-label={`Preview ${file}`}
                    onClick={() => setPreviewing(file)}
                  >
                    <img
                      src={url(file, "100x100")}
                      alt={file}
                      width={48}
                      height={48}
                    />
                  </button>
                ) : (
                  <a href={url(file)} target="_blank" rel="noopener noreferrer">
                    {file}
                  </a>
                )}
              </span>
              <Button disabled={disabled} onClick={() => toggle(file)}>
                {removed ? `Restore ${file}` : `Remove ${file}`}
              </Button>
            </li>
          );
        })}
        {value.added.map((file, i) => (
          <li key={`${file.name}-${i}`} className="flex items-center gap-2">
            <span>{file.name}</span>
            <Button
              aria-label={`Remove new ${file.name}`}
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...value,
                  added: value.added.filter((_, n) => n !== i),
                })
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <label className="flex flex-col gap-1 text-sm">
        Add files
        <input
          key={inputKey}
          type="file"
          multiple={multi}
          disabled={disabled || full}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => pick([...(e.target.files ?? [])])}
        />
      </label>
      {error && (
        <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {previewing && (
        <FilePreview
          name={previewing}
          url={url(previewing)}
          onClose={() => setPreviewing(null)}
        />
      )}
    </fieldset>
  );
}
