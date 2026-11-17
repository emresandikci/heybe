import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../app/errors";
import { useCollections } from "../app/queries";
import {
  Button,
  Dialog,
  Section,
  Select,
  TextField,
  useToast,
} from "@heybe/ui";
import { CheckInput, NumberInput, SecretInput, TextInput } from "./inputs";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function MailPage() {
  const settings = useSettings();
  if (!settings.data) return null;
  return <MailForm settings={settings.data} />;
}

function MailForm({ settings }: { settings: SettingsModel }) {
  const { form, dirty, version, save, submit, reset } =
    useSettingsForm(settings);
  const [testing, setTesting] = useState(false);
  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
        <Section title="Sender">
          <form.Field name="settings.meta.senderName">
            {(field) => (
              <TextInput
                path="meta.senderName"
                label="Sender name"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.meta.senderAddress">
            {(field) => (
              <TextInput
                path="meta.senderAddress"
                label="Sender address"
                field={field}
              />
            )}
          </form.Field>
        </Section>
        <Section title="SMTP">
          <form.Field name="settings.smtp.enabled">
            {(field) => (
              <CheckInput path="smtp.enabled" label="Use SMTP" field={field} />
            )}
          </form.Field>
          <form.Field name="settings.smtp.host">
            {(field) => (
              <TextInput path="smtp.host" label="Host" field={field} />
            )}
          </form.Field>
          <form.Field name="settings.smtp.port">
            {(field) => (
              <NumberInput path="smtp.port" label="Port" field={field} />
            )}
          </form.Field>
          <form.Field name="settings.smtp.username">
            {(field) => (
              <TextInput path="smtp.username" label="Username" field={field} />
            )}
          </form.Field>
          <form.Field name="secrets.smtpPassword">
            {(field) => (
              <SecretInput
                path="smtp.password"
                label="Password"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.smtp.authMethod">
            {(field) => (
              <AuthMethod
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="settings.smtp.tls">
            {(field) => (
              <CheckInput path="smtp.tls" label="TLS" field={field} />
            )}
          </form.Field>
          <form.Field name="settings.smtp.localName">
            {(field) => (
              <TextInput
                path="smtp.localName"
                label="Local name"
                field={field}
              />
            )}
          </form.Field>
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
  const [error, setError] = useState<unknown>(null);
  const authCollections = (collections.data ?? []).filter(
    (c) => c.type === "auth",
  );

  const form = useForm({
    defaultValues: {
      template: TEMPLATES[0]!,
      email: "",
      collection: "_superusers",
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await client.settings.testEmail(
          value.collection,
          value.email,
          value.template,
        );
        toast.success("Test email sent.");
        onClose();
      } catch (err) {
        setError(err);
      }
    },
  });

  return (
    <ErrorScope error={error}>
      <Dialog open onClose={onClose} title="Send test email">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-3"
        >
          <UnclaimedErrors />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Template</legend>
            <form.Field name="template">
              {(field) =>
                TEMPLATES.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="template"
                      checked={field.state.value === name}
                      onChange={() => field.handleChange(name)}
                    />
                    {name}
                  </label>
                ))
              }
            </form.Field>
          </fieldset>
          <form.Field name="email">
            {(field) => (
              <EmailInput
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="collection">
            {(field) => (
              <Select
                label="Auth collection"
                value={field.state.value}
                disabled={!collections.data}
                onChange={(e) => field.handleChange(e.target.value)}
              >
                {!collections.data && (
                  <option value={field.state.value}>{field.state.value}</option>
                )}
                {authCollections.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </form.Field>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" variant="primary" loading={isSubmitting}>
                  Send
                </Button>
              )}
            </form.Subscribe>
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
