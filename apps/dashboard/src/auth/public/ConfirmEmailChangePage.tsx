import { useForm } from "@tanstack/react-form";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors } from "../../app/errors";
import { Button } from "@heybejs/ui";
import { AuthCard, Field } from "../AuthCard";
import { collectionIdOf } from "./collection";
import { InvalidLink } from "./InvalidLink";

const TITLE = "Confirm new email";

export function ConfirmEmailChangePage() {
  const { token } = useParams({ from: "/auth/confirm-email-change/$token" });
  const collectionId = collectionIdOf(token);
  if (!collectionId) return <InvalidLink title={TITLE} />;
  return <ChangeForm token={token} collectionId={collectionId} />;
}

function ChangeForm({
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
    defaultValues: { password: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client
          .auth(collectionId)
          .confirmEmailChange(token, value.password);
        setDone(true);
      } catch (err) {
        setError(err);
      }
    },
  });

  if (done)
    return (
      <AuthCard title={TITLE}>
        <p role="status">Your email address was changed.</p>
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
                label="Password"
                type="password"
                autoFocus
                autoComplete="current-password"
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
                Confirm new email
              </Button>
            )}
          </form.Subscribe>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
