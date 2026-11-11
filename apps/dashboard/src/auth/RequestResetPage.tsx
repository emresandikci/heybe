import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { AuthCard } from "./AuthCard";

export function RequestResetPage() {
  const client = useClient();
  const [sent, setSent] = useState(false);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      await client
        .auth("_superusers")
        .requestPasswordReset(value.email)
        .catch(() => undefined);
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
