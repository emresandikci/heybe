import { Button } from "@heybe/ui";
import { UnclaimedErrors } from "../app/errors";

export function FormFooter({
  dirty,
  saving,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  onReset(): void;
}) {
  return (
    <div
      role="group"
      aria-label="Form actions"
      className="flex items-start justify-between gap-3 border-t border-line pt-4"
    >
      <div className="min-w-0 flex-1">
        <UnclaimedErrors />
      </div>
      <div className="flex shrink-0 gap-2">
        <Button disabled={!dirty} onClick={onReset}>
          Reset
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty}
          loading={saving}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}
