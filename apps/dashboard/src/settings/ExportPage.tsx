import { useState } from "react";
import { useCollections } from "../app/queries";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { CopyButton } from "../ui/CopyButton";
import { exportJson } from "./import-diff";

export function ExportPage() {
  const collections = useCollections();
  const [unselected, setUnselected] = useState<Set<string>>(new Set());
  if (!collections.data) return null;

  const all = collections.data;
  const selected = all.filter((c) => !unselected.has(c.id));
  const json = exportJson(selected);

  const toggle = (id: string) => {
    const next = new Set(unselected);
    if (!next.delete(id)) next.add(id);
    setUnselected(next);
  };

  const download = () => {
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "heybe_collections.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
        <legend className="mb-2 text-sm font-medium">Collections</legend>
        <Checkbox
          label="Select all"
          checked={selected.length === all.length}
          onChange={() =>
            setUnselected(
              selected.length === all.length
                ? new Set(all.map((c) => c.id))
                : new Set(),
            )
          }
        />
        {all.map((c) => (
          <Checkbox
            key={c.id}
            label={c.name}
            checked={!unselected.has(c.id)}
            onChange={() => toggle(c.id)}
          />
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button variant="primary" onClick={download}>
          Download
        </Button>
        <CopyButton text={json} />
      </div>
      <pre
        aria-label="Export preview"
        className="max-h-[32rem] overflow-auto rounded border border-slate-200 p-3 text-xs dark:border-slate-700"
      >
        {json}
      </pre>
    </div>
  );
}
