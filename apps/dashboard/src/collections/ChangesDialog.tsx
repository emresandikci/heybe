import { Button, Dialog } from "@heybe/ui";
import type { Changes } from "./editor-state";

export function ChangesDialog({
  changes,
  onConfirm,
  onCancel,
}: {
  changes: Changes;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { renamedCollection, deletedFields, renamedFields, changedRules } =
    changes;
  return (
    <Dialog
      open
      onClose={onCancel}
      title="Confirm changes"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>
            Confirm
          </Button>
        </>
      }
    >
      <p className="text-sm">Review these changes before saving.</p>
      <ul className="mt-2 list-disc pl-5 text-sm">
        {renamedCollection && (
          <li>
            Rename collection {renamedCollection[0]} to {renamedCollection[1]}
          </li>
        )}
        {deletedFields.map((name) => (
          <li key={`delete-${name}`}>Delete field {name}</li>
        ))}
        {renamedFields.map(([from, to]) => (
          <li key={`rename-${from}`}>
            Rename field {from} to {to}
          </li>
        ))}
        {changedRules.length > 0 && (
          <li>Change API rules: {changedRules.join(", ")}</li>
        )}
      </ul>
      {deletedFields.length > 0 && (
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          Deleted fields lose all their data.
        </p>
      )}
    </Dialog>
  );
}
