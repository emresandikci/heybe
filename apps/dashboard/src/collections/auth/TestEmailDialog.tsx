import { useState, type FormEvent } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../../app/errors";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextField } from "../../ui/TextField";
import { useToast } from "../../ui/Toasts";

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
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.settings.testEmail(collection, email, template);
      toast.success("Test email sent.");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ErrorScope error={error}>
      <Dialog open onClose={onClose} title="Send test email">
        <form onSubmit={send} className="flex flex-col gap-3">
          <UnclaimedErrors />
          <EmailInput value={email} onChange={setEmail} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Send
            </Button>
          </div>
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
