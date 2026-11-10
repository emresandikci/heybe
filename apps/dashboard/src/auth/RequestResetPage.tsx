import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useClient } from "../app/context";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { AuthCard } from "./AuthCard";

export function RequestResetPage() {
  const client = useClient();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await client
      .auth("_superusers")
      .requestPasswordReset(email)
      .catch(() => undefined);
    setBusy(false);
    setSent(true);
  };

  return (
    <AuthCard title="Reset password">
      {sent ? (
        <p role="status">If the email exists, a reset link was sent.</p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/login" className="text-sm underline">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
