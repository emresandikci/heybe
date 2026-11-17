import { HeybeError } from "@heybe/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { useRef, useState, type ChangeEvent } from "react";
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
  Section,
  Select,
  Table,
  Td,
  TextField,
  Th,
  useConfirm,
  useToast,
} from "@heybe/ui";
import { formatBytes } from "./format";
import { NumberInput, TextInput, type FieldLike } from "./inputs";
import { S3Fields, TestS3Button } from "./S3Fields";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function BackupsPage() {
  const settings = useSettings();
  return (
    <div className="flex flex-col gap-6">
      <BackupsList />
      {settings.data && <AutomaticBackups settings={settings.data} />}
    </div>
  );
}

function BackupsList() {
  const client = useClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
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
  });
  const busy = health.data?.data.canBackup === false;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.backups }),
      queryClient.invalidateQueries({ queryKey: keys.health }),
    ]);

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await client.backups.upload(file);
      toast.success("Backup uploaded.");
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const download = async (key: string) => {
    try {
      const token = await client.files.token();
      window.open(client.backups.downloadURL(token, key), "_blank", "noopener");
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

  const restore = async (key: string) => {
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
      setRestoring(true);
    } catch (err) {
      // status 0 without an abort: the server dropped the connection while restarting
      if (err instanceof HeybeError && err.status === 0 && !err.isAbort)
        setRestoring(true);
      else toast.error(errorMessage(err));
    }
  };

  return (
    <section aria-label="Backups" className="flex flex-col gap-3">
      {restoring && (
        <div
          role="status"
          className="flex items-center gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>
            Restore started. The server restarts with the restored data; reload
            this page in a few seconds.
          </p>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={() => setCreating(true)}>
          Create backup
        </Button>
        <Button onClick={() => fileInput.current?.click()}>
          Upload backup
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          aria-label="Backup file"
          className="hidden"
          onChange={(e) => void upload(e)}
        />
        {busy && (
          <p className="text-sm">A backup or restore is already running.</p>
        )}
      </div>
      {backups.data && (
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
                    <Button disabled={busy} onClick={() => void restore(b.key)}>
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
    </section>
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
      <Dialog open onClose={onClose} title="Create backup">
        <form
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
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" variant="primary" loading={isSubmitting}>
                  Create
                </Button>
              )}
            </form.Subscribe>
          </div>
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
      hint="Leave empty for a generated name."
      value={value}
      error={useFieldError("name")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const PRESETS = ["", "0 0 * * *", "0 0 * * 0"];

function CronField({ field }: { field: FieldLike<string> }) {
  const value = field.state.value;
  const onChange = field.handleChange;
  const [custom, setCustom] = useState(!PRESETS.includes(value));
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
  const { form, dirty, version, save, submit, reset } =
    useSettingsForm(settings);
  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
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
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save changes
          </Button>
          <Button onClick={reset}>Reset</Button>
        </div>
      </form>
    </ErrorScope>
  );
}
