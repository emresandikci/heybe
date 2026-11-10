import { tokenExpired } from "@heybe/client";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors } from "../app/errors";
import { Button } from "../ui/Button";
import { AuthCard, Field } from "./AuthCard";

export function InstallerPage() {
  const { token } = useParams({ from: "/pbinstall/$token" });
  if (tokenExpired(token, Date.now()))
    return (
      <AuthCard title="Create your first superuser">
        <p role="alert">
          This installer link has expired. Restart the server to print a new
          one.
        </p>
      </AuthCard>
    );
  return <Installer token={token} />;
}

function Installer({ token }: { token: string }) {
  const client = useClient();
  const navigate = useNavigate();
  const installer = { headers: { Authorization: token } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client
        .records("_superusers")
        .create({ email, password, passwordConfirm }, undefined, installer);
      await client.auth("_superusers").withPassword(email, password);
      await navigate({ to: "/collections" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setRestoreError(null);
    try {
      await client.backups.upload(file, installer);
      await client.backups.restore(file.name, installer);
      setRestoring(true);
    } catch (err) {
      setRestoreError(err);
    } finally {
      setBusy(false);
    }
  };

  if (restoring)
    return (
      <AuthCard title="Restoring backup">
        <p role="status">
          Restore started. The server restarts with the restored data; reload
          this page in a few seconds.
        </p>
        <Button
          variant="primary"
          onClick={async () => {
            await navigate({ to: "/login" });
            location.reload();
          }}
        >
          Reload
        </Button>
      </AuthCard>
    );

  return (
    <AuthCard title="Create your first superuser">
      <ErrorScope error={error}>
        <form onSubmit={create} className="flex flex-col gap-3">
          <Field
            path="email"
            label="Email"
            type="email"
            autoFocus
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            path="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            path="passwordConfirm"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            required
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
          <UnclaimedErrors />
          <Button type="submit" variant="primary" loading={busy}>
            Create superuser
          </Button>
        </form>
      </ErrorScope>
      <ErrorScope error={restoreError}>
        <form
          onSubmit={restore}
          className="flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700"
        >
          <h2 className="font-medium">Restore from a backup</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The backup is not validated. Only use files you trust.
          </p>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Backup file
            <input
              type="file"
              accept=".zip,application/zip"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <UnclaimedErrors />
          <Button type="submit" loading={busy} disabled={!file}>
            Upload and restore
          </Button>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
