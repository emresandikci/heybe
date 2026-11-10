import type { CollectionModel } from "@heybe/client";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button } from "../ui/Button";
import { CopyButton } from "../ui/CopyButton";
import { Dialog } from "../ui/Dialog";
import { NumberField } from "../ui/NumberField";
import { TextField } from "../ui/TextField";

export function ImpersonateDialog({
  collection,
  recordId,
  label,
  onClose,
}: {
  collection: CollectionModel;
  recordId: string;
  label: string;
  onClose: () => void;
}) {
  const client = useClient();
  const [duration, setDuration] = useState("0");
  const [durationError, setDurationError] = useState<string>();
  const generate = useMutation({
    mutationFn: async () => {
      const impersonated = await client
        .auth(collection.name)
        .impersonate(recordId, Number(duration));
      return impersonated.authStore.token;
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d+$/.test(duration)) {
      setDurationError("Enter a whole number of seconds, 0 or more.");
      return;
    }
    setDurationError(undefined);
    generate.mutate();
  };

  return (
    <Dialog
      open
      title={`Impersonate ${label}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <NumberField
          label="Token duration (seconds)"
          hint="0 uses the collection's auth token duration."
          min={0}
          step={1}
          error={durationError}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
        />
        <Button type="submit" variant="primary" loading={generate.isPending}>
          Generate token
        </Button>
        {generate.isError && (
          <p role="alert" className="text-sm text-red-600">
            {errorMessage(generate.error)}
          </p>
        )}
        {generate.data && (
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <TextField
                  label="Token"
                  readOnly
                  value={generate.data}
                  className="font-mono"
                />
              </div>
              <CopyButton label="Copy token" text={generate.data} />
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              This token is not refreshable.
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
