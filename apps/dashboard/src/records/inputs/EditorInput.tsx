import { useState } from "react";
import { Button } from "../../ui/Button";
import { CodeArea } from "../../ui/CodeArea";

export function EditorInput({
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
  const [preview, setPreview] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <CodeArea
        label={name}
        language="html"
        value={value}
        error={error}
        disabled={disabled}
        onChange={onChange}
      />
      <Button
        aria-pressed={preview}
        className="self-start"
        onClick={() => setPreview(!preview)}
      >
        Preview
      </Button>
      {preview && (
        <iframe
          title={`${name} preview`}
          sandbox=""
          srcDoc={value}
          className="h-48 w-full rounded border border-slate-300 bg-white dark:border-slate-600"
        />
      )}
    </div>
  );
}
