import { useForm } from "@tanstack/react-form";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors } from "../../app/errors";
import { Button } from "@heybe/ui";
import { AuthCard, Field } from "../AuthCard";
import { collectionIdOf } from "./collection";
import { InvalidLink } from "./InvalidLink";

const TITLE = "Reset password";
const SUPERUSERS_ID = "hbc_3142635823";

export function ConfirmPasswordResetPage() {
  const { token } = useParams({ from: "/auth/confirm-password-reset/$token" });
  const collectionId = collectionIdOf(token);
  if (!collectionId) return <InvalidLink title={TITLE} />;
  return <ResetForm token={token} collectionId={collectionId} />;
}

function ResetForm({
  token,
  collectionId,
}: {
  token: string;
  collectionId: string;
}) {
  const client = useClient();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const form = useForm({
    defaultValues: { password: "", passwordConfirm: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client
          .auth(collectionId)
          .confirmPasswordReset(token, value.password, value.passwordConfirm);
        setDone(true);
      } catch (err) {
        setError(err);
      }
    },
  });

  if (done)
    return (
      <AuthCard title={TITLE}>
        <p role="status">Your password was changed.</p>
        {collectionId === SUPERUSERS_ID && (
          <Link to="/login" className="text-sm underline">
            Sign in
          </Link>
        )}
      </AuthCard>
    );

  return (
    <AuthCard title={TITLE}>
      <ErrorScope error={error}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <form.Field name="password">
            {(field) => (
              <Field
                path="password"
                label="New password"
                type="password"
                autoFocus
                autoComplete="new-password"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <form.Field name="passwordConfirm">
            {(field) => (
              <Field
                path="passwordConfirm"
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </form.Field>
          <UnclaimedErrors />
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button type="submit" variant="primary" loading={isSubmitting}>
                Set new password
              </Button>
            )}
          </form.Subscribe>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
