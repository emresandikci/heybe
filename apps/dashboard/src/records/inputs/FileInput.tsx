import { useState } from "react";
import { useClient } from "../../app/context";
import { Button, FileField } from "@heybe/ui";
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
              <span
                className={`flex min-w-0 flex-1 items-center gap-2 ${removed ? "line-through opacity-50" : ""}`}
              >
                {!waiting && IMAGE.test(file) && (
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
                )}
                {waiting || IMAGE.test(file) ? (
                  <span className="min-w-0 truncate" title={file}>
                    {file}
                  </span>
                ) : (
                  <a
                    href={url(file)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate"
                    title={file}
                  >
                    {file}
                  </a>
                )}
              </span>
              <Button
                aria-label={`${removed ? "Restore" : "Remove"} ${file}`}
                disabled={disabled}
                onClick={() => toggle(file)}
              >
                {removed ? "Restore" : "Remove"}
              </Button>
            </li>
          );
        })}
        {value.added.map((file, i) => (
          <li key={`${file.name}-${i}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate" title={file.name}>
              {file.name}
            </span>
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
      <div className="[&_label]:sr-only">
        <FileField
          key={inputKey}
          label="Add files"
          multiple={multi}
          disabled={disabled || full}
          error={error}
          onChange={pick}
        />
      </div>
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
