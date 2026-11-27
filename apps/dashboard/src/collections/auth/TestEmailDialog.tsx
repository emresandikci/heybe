import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../../app/errors";
import { Button, Dialog, TextField, useToast } from "@heybejs/ui";

export function TestEmailDialog({
  collection,
  template,
  onClose,
}: {
  collection: string;
  template: string;
  onClose: () => void;
}) {
  const client = useClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client.settings.testEmail(collection, value.email, template);
        toast.success("Test email sent.");
        onClose();
      } catch (err) {
        setError(err);
      }
    },
  });

  return (
    <ErrorScope error={error}>
      <Dialog
        open
        onClose={onClose}
        title="Send test email"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  form="test-email"
                  variant="primary"
                  loading={isSubmitting}
                >
                  Send
                </Button>
              )}
            </form.Subscribe>
          </>
        }
      >
        <form
          id="test-email"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <UnclaimedErrors />
          <form.Field name="email">
            {(field) => (
              <EmailInput
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
        </form>
      </Dialog>
    </ErrorScope>
  );
}

function EmailInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <TextField
      label="Email"
      type="email"
      required
      value={value}
      error={useFieldError("email")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
