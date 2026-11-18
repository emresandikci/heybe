import { tokenExpired } from "@heybe/client";
import { useForm } from "@tanstack/react-form";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors } from "../app/errors";
import { Button, FileField } from "@heybe/ui";
import { AuthCard, Field } from "./AuthCard";

export function InstallerPage() {
  const { token } = useParams({ from: "/hbinstall/$token" });
  if (tokenExpired(token, Date.now()))
    return (
      <AuthCard title="Installer link expired">
        <p role="alert">
          This installer link has expired. Restart the server to print a new
          one.
        </p>
        <Link to="/login" className="text-accent-text hover:underline">
          Sign in
        </Link>
      </AuthCard>
    );
  return <Installer token={token} />;
}

function Installer({ token }: { token: string }) {
  const client = useClient();
  const navigate = useNavigate();
  const installer = { headers: { Authorization: token } };
  const [error, setError] = useState<unknown>(null);
  const [restoreError, setRestoreError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);

  const createForm = useForm({
    defaultValues: { email: "", password: "", passwordConfirm: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client.records("_superusers").create(value, undefined, installer);
        await client
          .auth("_superusers")
          .withPassword(value.email, value.password);
        await navigate({ to: "/collections" });
      } catch (err) {
        setError(err);
      }
    },
  });

  const restoreForm = useForm({
    defaultValues: { file: null as File | null },
    onSubmit: async ({ value: { file } }) => {
      if (!file) return;
      setRestoreError(null);
      try {
        await client.backups.upload(file, installer);
        await client.backups.restore(file.name, installer);
        setRestoring(true);
      } catch (err) {
        setRestoreError(err);
      }
    },
  });

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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createForm.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <createForm.Field name="email">
            {(field) => (
              <Field
                path="email"
                label="Email"
                type="email"
                autoFocus
                autoComplete="username"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </createForm.Field>
          <createForm.Field name="password">
            {(field) => (
              <Field
                path="password"
                label="Password"
                type="password"
                autoComplete="new-password"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </createForm.Field>
          <createForm.Field name="passwordConfirm">
            {(field) => (
              <Field
                path="passwordConfirm"
                label="Confirm password"
                type="password"
                autoComplete="new-password"
                required
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            )}
          </createForm.Field>
          <UnclaimedErrors />
          <createForm.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <restoreForm.Subscribe selector={(s) => s.isSubmitting}>
                {(restoreSubmitting) => (
                  <Button
                    type="submit"
                    variant="primary"
                    loading={isSubmitting}
                    disabled={restoreSubmitting}
                  >
                    Create superuser
                  </Button>
                )}
              </restoreForm.Subscribe>
            )}
          </createForm.Subscribe>
        </form>
      </ErrorScope>
      <ErrorScope error={restoreError}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void restoreForm.handleSubmit();
          }}
          className="flex flex-col gap-3 border-t border-line pt-4"
        >
          <h2 className="font-medium">Restore from a backup</h2>
          <p className="text-sm text-muted">
            The backup is not validated. Only use files you trust.
          </p>
          <restoreForm.Field name="file">
            {(field) => (
              <FileField
                label="Backup file"
                accept=".zip,application/zip"
                onChange={(files) => field.handleChange(files[0] ?? null)}
              />
            )}
          </restoreForm.Field>
          <UnclaimedErrors />
          <restoreForm.Subscribe
            selector={(s) => [s.isSubmitting, s.values.file] as const}
          >
            {([isSubmitting, file]) => (
              <createForm.Subscribe selector={(s) => s.isSubmitting}>
                {(createSubmitting) => (
                  <Button
                    type="submit"
                    loading={isSubmitting}
                    disabled={!file || createSubmitting}
                  >
                    Upload and restore
                  </Button>
                )}
              </createForm.Subscribe>
            )}
          </restoreForm.Subscribe>
        </form>
      </ErrorScope>
    </AuthCard>
  );
}
