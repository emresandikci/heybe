import { useState } from "react";
import { useCollections } from "../app/queries";
import { Button, Checkbox, CopyButton } from "@heybejs/ui";
import { exportJson } from "./import-diff";
import { QueryStatus } from "./QueryStatus";
import { SettingsPage } from "./SettingsPage";

export function ExportPage() {
  const collections = useCollections();
  const [unselected, setUnselected] = useState<Set<string>>(new Set());
  if (!collections.data)
    return (
      <SettingsPage title="Export collections">
        <QueryStatus query={collections} />
      </SettingsPage>
    );

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
    // revoking in the same task can cancel the download in Firefox and Safari
    setTimeout(() => URL.revokeObjectURL(url));
  };

  return (
    <SettingsPage title="Export collections">
      <div className="flex flex-col gap-3">
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
        <CollectionGroup
          legend="Collections"
          items={all.filter((c) => !c.system)}
          unselected={unselected}
          onToggle={toggle}
        />
        <CollectionGroup
          legend="System collections"
          items={all.filter((c) => c.system)}
          unselected={unselected}
          onToggle={toggle}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={download}>
            Download
          </Button>
          <CopyButton text={json} label="Copy JSON" showLabel />
        </div>
        <pre
          aria-label="Export preview"
          className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-control border border-line p-3 font-mono text-xs"
        >
          {json}
        </pre>
      </div>
    </SettingsPage>
  );
}

function CollectionGroup({
  legend,
  items,
  unselected,
  onToggle,
}: {
  legend: string;
  items: { id: string; name: string }[];
  unselected: Set<string>;
  onToggle(id: string): void;
}) {
  if (items.length === 0) return null;
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {items.map((c) => (
        <Checkbox
          key={c.id}
          label={c.name}
          checked={!unselected.has(c.id)}
          onChange={() => onToggle(c.id)}
        />
      ))}
    </fieldset>
  );
}
