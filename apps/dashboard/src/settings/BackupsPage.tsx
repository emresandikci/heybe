import { HeybeError } from "@heybejs/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../app/context";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  useFieldError,
} from "../app/errors";
import { keys } from "../app/queries";
import {
  Button,
  Dialog,
  EmptyState,
  FileField,
  Section,
  Select,
  Table,
  Td,
  TextField,
  Th,
  useConfirm,
  useToast,
} from "@heybejs/ui";
import { formatBytes } from "./format";
import { NumberInput, TextInput, type FieldLike } from "./inputs";
import { QueryStatus } from "./QueryStatus";
import { FormFooter } from "./FormFooter";
import { SettingsPage } from "./SettingsPage";
import { S3Fields, TestS3Button } from "./S3Fields";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function BackupsPage() {
  const settings = useSettings();
  return (
    <SettingsPage title="Backups">
      <div className="flex flex-col gap-6">
        <BackupsList />
        {settings.data ? (
          <AutomaticBackups settings={settings.data} />
        ) : (
          <QueryStatus query={settings} />
        )}
      </div>
    </SettingsPage>
  );
}

function BackupsList() {
  const client = useClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [restore, setRestore] = useState<{
    at: number;
    accepted: boolean;
    answered: boolean;
  } | null>(null);
  const backups = useQuery({
    queryKey: keys.backups,
    queryFn: ({ signal }) =>
      client.backups
        .list({ signal })
        .then((list) =>
          list.sort((x, y) => y.modified.localeCompare(x.modified)),
        ),
  });
  const health = useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => client.health.check({ signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.data.canBackup === false ||
      (restore && !restore.answered)
        ? HEALTH_POLL_MS
        : false,
  });
  const busy = health.data?.data.canBackup === false;
  // the restart can fit between two polls, so an idle server some time after the request counts too
  if (
    restore &&
    !restore.answered &&
    health.isSuccess &&
    !busy &&
    health.dataUpdatedAt > restore.at + RESTORE_SETTLE_MS
  )
    setRestore({ ...restore, answered: true });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.backups }),
      queryClient.invalidateQueries({ queryKey: keys.health }),
    ]);

  const [uploading, setUploading] = useState(false);
  const upload = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setUploading(true);
    try {
      await client.backups.upload(file);
      toast.success("Backup uploaded.");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const download = async (key: string) => {
    try {
      const token = await client.files.token();
      // a new window opened after an await is blocked as a popup; a same-origin download link is not
      const link = document.createElement("a");
      link.href = client.backups.downloadURL(token, key);
      link.download = key;
      link.click();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (key: string) => {
    const ok = await confirm({
      title: "Delete backup",
      message: `Delete ${key}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await client.backups.delete(key);
      toast.success("Backup deleted.");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const runRestore = async (key: string) => {
    const ok = await confirm({
      title: "Restore backup",
      message: `Restore ${key}? The current data is replaced and the server restarts.`,
      confirmLabel: "Restore",
      danger: true,
      typeToConfirm: key,
    });
    if (!ok) return;
    try {
      await client.backups.restore(key);
      setRestore({ at: Date.now(), accepted: true, answered: false });
    } catch (err) {
      // status 0 without an abort: the server may have restarted, or the request never arrived
      if (err instanceof HeybeError && err.status === 0 && !err.isAbort)
        setRestore({ at: Date.now(), accepted: false, answered: false });
      else toast.error(errorMessage(err));
    }
  };

  return (
    <Section title="Backup files">
      {restore && (
        <div
          role="status"
          className="flex items-center gap-3 rounded border border-warning-line bg-warning-bg p-3 text-sm text-warning-text"
        >
          <p>
            {restore.accepted
              ? "Restore started. The server restarts with the restored data."
              : "The connection was lost, so the restore may not have started."}
            {restore.answered &&
              " The server is answering again: reload this page and check the data."}
          </p>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      )}
      <div className="flex flex-col items-start gap-3">
        <Button disabled={busy} onClick={() => setCreating(true)}>
          Create backup
        </Button>
        <div className="w-full">
          <FileField
            label="Backup file"
            accept=".zip"
            disabled={uploading}
            onChange={(files) => void upload(files)}
          />
        </div>
        {busy && (
          <p className="text-sm">A backup or restore is already running.</p>
        )}
      </div>
      {!backups.data ? (
        <QueryStatus query={backups} />
      ) : backups.data.length === 0 ? (
        <EmptyState title="No backups yet.">
          <p>Create a backup or upload a backup file.</p>
        </EmptyState>
      ) : (
        <Table caption="Backups">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Size</Th>
              <Th>Modified</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {backups.data.map((b) => (
              <tr key={b.key}>
                <Td>{b.key}</Td>
                <Td>{formatBytes(b.size)}</Td>
                <Td>{b.modified}</Td>
                <Td>
                  <div className="flex gap-2">
                    <Button onClick={() => void download(b.key)}>
                      Download
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => void runRestore(b.key)}
                    >
                      Restore
                    </Button>
                    <Button onClick={() => void remove(b.key)}>Delete</Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={() => void refresh()}
        />
      )}
    </Section>
  );
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(): void;
}) {
  const client = useClient();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);

  const form = useForm({
    defaultValues: { name: "" },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client.backups.create(value.name || undefined);
        toast.success("Backup created.");
        onCreated();
        onClose();
      } catch (err) {
        setError(err);
      }
    },
  });

  return (
    <ErrorScope error={error}>
      <Dialog
        open
        onClose={onClose}
        title="Create backup"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  form="create-backup"
                  variant="primary"
                  loading={isSubmitting}
                >
                  Create
                </Button>
              )}
            </form.Subscribe>
          </>
        }
      >
        <form
          id="create-backup"
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <UnclaimedErrors />
          <form.Field name="name">
            {(field) => (
              <NameInput
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
        </form>
      </Dialog>
    </ErrorScope>
  );
}

function NameInput({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextField
      label="Name"
      hint="Lowercase letters, digits, - and _, ending in .zip. Leave empty for a generated name."
      value={value}
      error={useFieldError("name")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const PRESETS = ["", "0 0 * * *", "0 0 * * 0"];
const HEALTH_POLL_MS = 1000;
const RESTORE_SETTLE_MS = 5000;

function CronField({ field }: { field: FieldLike<string> }) {
  const value = field.state.value;
  const onChange = field.handleChange;
  const [customPicked, setCustom] = useState(false);
  // a stored or reset value outside the presets is custom, whatever was picked before
  const custom = customPicked || !PRESETS.includes(value);
  return (
    <>
      <ScheduleSelect
        value={custom ? "custom" : value}
        onChange={(next) => {
          setCustom(next === "custom");
          if (next !== "custom") onChange(next);
        }}
      />
      {custom && (
        <TextInput
          path="backups.cron"
          label="Custom cron expression"
          field={field}
        />
      )}
    </>
  );
}

function ScheduleSelect({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <Select
      label="Schedule"
      value={value}
      error={useFieldError("backups.cron")}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Off</option>
      <option value="0 0 * * *">Every day at 00:00</option>
      <option value="0 0 * * 0">Every Sunday at 00:00</option>
      <option value="custom">Custom</option>
    </Select>
  );
}

function AutomaticBackups({ settings }: { settings: SettingsModel }) {
  const { form, dirty, save, submit, reset } = useSettingsForm(settings);
  return (
    <ErrorScope error={save.error}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Section title="Automatic backups">
          <form.Field name="settings.backups.cron">
            {(field) => <CronField field={field} />}
          </form.Field>
          <form.Field name="settings.backups.cronMaxKeep">
            {(field) => (
              <NumberInput
                path="backups.cronMaxKeep"
                label="Keep the last"
                field={field}
              />
            )}
          </form.Field>
          <S3Fields form={form} prefix="backups.s3" />
          <TestS3Button filesystem="backups" disabled={dirty} />
        </Section>
        <FormFooter dirty={dirty} saving={save.isPending} onReset={reset} />
      </form>
    </ErrorScope>
  );
}
