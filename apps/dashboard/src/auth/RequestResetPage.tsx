import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, TextField } from "@heybe/ui";
import { AuthCard } from "./AuthCard";

export function RequestResetPage() {
  const client = useClient();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client.auth("_superusers").requestPasswordReset(value.email);
      } catch (err) {
        // a 4xx answer gets the same confirmation, so it tells nothing about the email;
        // no answer (status 0) or a server error means no link was sent
        const status = (err as { status?: number }).status ?? 0;
        if (status === 0 || status >= 500) return setError(err);
      }
      setSent(true);
    },
  });

  return (
    <AuthCard title="Reset password">
      {sent ? (
        <p role="status">If the email exists, a reset link was sent.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <form.Field name="email">
            {(field) => (
              <TextField
                label="Email"
                type="email"
                autoComplete="username"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          {error !== null && <p role="alert">{errorMessage(error)}</p>}
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" variant="primary" loading={isSubmitting}>
                Send reset link
              </Button>
            )}
          </form.Subscribe>
        </form>
      )}
      <Link to="/login" className="text-sm underline">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
