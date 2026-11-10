import { Link, useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors } from "../../app/errors";
import { Button } from "../../ui/Button";
import { AuthCard, Field } from "../AuthCard";
import { collectionIdOf } from "./collection";
import { InvalidLink } from "./InvalidLink";

const TITLE = "Reset password";
const SUPERUSERS_ID = "pbc_3142635823";

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
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client
        .auth(collectionId)
        .confirmPasswordReset(token, password, passwordConfirm);
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

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
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            path="password"
            label="New password"
            type="password"
            autoFocus
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            path="passwordConfirm"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
          <UnclaimedErrors />
          <Button type="submit" variant="primary" loading={busy}>
            Set new password
          </Button>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
