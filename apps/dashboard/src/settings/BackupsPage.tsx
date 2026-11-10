import { HeybeError } from "@heybe/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useClient } from "../app/context";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  useFieldError,
} from "../app/errors";
import { keys } from "../app/queries";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/Confirm";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Table, Td, Th } from "../ui/Table";
import { TextField } from "../ui/TextField";
import { useToast } from "../ui/Toasts";
import { formatBytes } from "./format";
import { NumberInput, Section, TextInput } from "./inputs";
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
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.backups.create(name || undefined);
      toast.success("Backup created.");
      onCreated();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ErrorScope error={error}>
      <Dialog open onClose={onClose} title="Create backup">
        <form onSubmit={create} className="flex flex-col gap-3">
          <UnclaimedErrors />
          <NameInput value={name} onChange={setName} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create
            </Button>
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

function CronField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
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
          value={value}
          onChange={onChange}
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
  const {
    draft,
    set,
    secrets,
    setSecret,
    dirty,
    version,
    save,
    submit,
    reset,
  } = useSettingsForm(settings);
  const { backups } = draft;
  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
        <Section title="Automatic backups">
          <CronField
            value={backups.cron}
            onChange={(cron) => set("backups", { cron })}
          />
          <NumberInput
            path="backups.cronMaxKeep"
            label="Keep the last"
            value={backups.cronMaxKeep}
            onChange={(cronMaxKeep) => set("backups", { cronMaxKeep })}
          />
          <S3Fields
            prefix="backups.s3"
            value={backups.s3}
            onChange={(patch) =>
              set("backups", { s3: { ...backups.s3, ...patch } })
            }
            secret={secrets["backups.s3.secret"] ?? ""}
            onSecretChange={(value) => setSecret("backups.s3.secret", value)}
          />
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
