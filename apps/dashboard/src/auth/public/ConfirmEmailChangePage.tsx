import { useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors } from "../../app/errors";
import { Button } from "../../ui/Button";
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
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.auth(collectionId).confirmEmailChange(token, password);
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
        <p role="status">Your email address was changed.</p>
      </AuthCard>
    );

  return (
    <AuthCard title={TITLE}>
      <ErrorScope error={error}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            path="password"
            label="Password"
            type="password"
            autoFocus
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <UnclaimedErrors />
          <Button type="submit" variant="primary" loading={busy}>
            Confirm new email
          </Button>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
