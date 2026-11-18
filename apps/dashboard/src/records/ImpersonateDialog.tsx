import type { CollectionModel } from "@heybe/client";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, CopyButton, Dialog, NumberField, TextField } from "@heybe/ui";

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
  const generate = useMutation({
    mutationFn: async (duration: number) => {
      const impersonated = await client
        .auth(collection.name)
        .impersonate(recordId, duration);
      return impersonated.authStore.token;
    },
  });

  const form = useForm({
    defaultValues: { duration: "0" },
    onSubmit: ({ value }) =>
      generate.mutateAsync(Number(value.duration)).catch(() => undefined),
  });

  return (
    <Dialog
      open
      title={`Impersonate ${label}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-4"
      >
        <form.Field
          name="duration"
          validators={{
            onSubmit: ({ value }) =>
              /^\d+$/.test(value)
                ? undefined
                : "Enter a whole number of seconds, 0 or more.",
          }}
        >
          {(field) => (
            <NumberField
              label="Token duration (seconds)"
              hint="0 uses the collection's auth token duration."
              min={0}
              step={1}
              error={field.state.meta.errors[0]}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" variant="primary" loading={isSubmitting}>
              Generate token
            </Button>
          )}
        </form.Subscribe>
        {generate.isError && (
          <p role="alert" className="text-sm text-danger-text">
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
            <p className="text-sm text-muted">This token is not refreshable.</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
