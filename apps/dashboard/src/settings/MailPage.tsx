import { useState, type FormEvent } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../app/errors";
import { useCollections } from "../app/queries";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import { useToast } from "../ui/Toasts";
import {
  CheckInput,
  NumberInput,
  SecretInput,
  Section,
  TextInput,
} from "./inputs";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function MailPage() {
  const settings = useSettings();
  if (!settings.data) return null;
  return <MailForm settings={settings.data} />;
}

function MailForm({ settings }: { settings: SettingsModel }) {
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
  const [testing, setTesting] = useState(false);
  const { meta, smtp } = draft;
  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
        <Section title="Sender">
          <TextInput
            path="meta.senderName"
            label="Sender name"
            value={meta.senderName}
            onChange={(senderName) => set("meta", { senderName })}
          />
          <TextInput
            path="meta.senderAddress"
            label="Sender address"
            value={meta.senderAddress}
            onChange={(senderAddress) => set("meta", { senderAddress })}
          />
        </Section>
        <Section title="SMTP">
          <CheckInput
            path="smtp.enabled"
            label="Use SMTP"
            checked={smtp.enabled}
            onChange={(enabled) => set("smtp", { enabled })}
          />
          <TextInput
            path="smtp.host"
            label="Host"
            value={smtp.host}
            onChange={(host) => set("smtp", { host })}
          />
          <NumberInput
            path="smtp.port"
            label="Port"
            value={smtp.port}
            onChange={(port) => set("smtp", { port })}
          />
          <TextInput
            path="smtp.username"
            label="Username"
            value={smtp.username}
            onChange={(username) => set("smtp", { username })}
          />
          <SecretInput
            path="smtp.password"
            label="Password"
            value={secrets["smtp.password"] ?? ""}
            onChange={(value) => setSecret("smtp.password", value)}
          />
          <AuthMethod
            value={smtp.authMethod}
            onChange={(authMethod) => set("smtp", { authMethod })}
          />
          <CheckInput
            path="smtp.tls"
            label="TLS"
            checked={smtp.tls}
            onChange={(tls) => set("smtp", { tls })}
          />
          <TextInput
            path="smtp.localName"
            label="Local name"
            value={smtp.localName}
            onChange={(localName) => set("smtp", { localName })}
          />
        </Section>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save changes
          </Button>
          <Button onClick={reset}>Reset</Button>
          <Button disabled={dirty} onClick={() => setTesting(true)}>
            Send test email
          </Button>
        </div>
      </form>
      {testing && <TestEmailDialog onClose={() => setTesting(false)} />}
    </ErrorScope>
  );
}

function AuthMethod({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <Select
      label="Auth method"
      value={value}
      error={useFieldError("smtp.authMethod")}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Default</option>
      <option value="PLAIN">PLAIN</option>
      <option value="LOGIN">LOGIN</option>
    </Select>
  );
}

const TEMPLATES = [
  "verification",
  "password-reset",
  "email-change",
  "otp",
  "login-alert",
];

function TestEmailDialog({ onClose }: { onClose: () => void }) {
  const client = useClient();
  const toast = useToast();
  const collections = useCollections();
  const [template, setTemplate] = useState(TEMPLATES[0]!);
  const [email, setEmail] = useState("");
  const [collection, setCollection] = useState("_superusers");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const authCollections = (collections.data ?? []).filter(
    (c) => c.type === "auth",
  );

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.settings.testEmail(collection, email, template);
      toast.success("Test email sent.");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ErrorScope error={error}>
      <Dialog open onClose={onClose} title="Send test email">
        <form onSubmit={send} className="flex flex-col gap-3">
          <UnclaimedErrors />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Template</legend>
            {TEMPLATES.map((name) => (
              <label key={name} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="template"
                  checked={template === name}
                  onChange={() => setTemplate(name)}
                />
                {name}
              </label>
            ))}
          </fieldset>
          <EmailInput value={email} onChange={setEmail} />
          <Select
            label="Auth collection"
            value={collection}
            disabled={!collections.data}
            onChange={(e) => setCollection(e.target.value)}
          >
            {!collections.data && (
              <option value={collection}>{collection}</option>
            )}
            {authCollections.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>
              Send
            </Button>
          </div>
        </form>
      </Dialog>
    </ErrorScope>
  );
}

function EmailInput({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <TextField
      label="Email"
      type="email"
      required
      value={value}
      error={useFieldError("email")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
