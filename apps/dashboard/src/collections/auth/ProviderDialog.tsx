import { useState } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../../app/errors";
import { Button } from "../../ui/Button";
import { CodeArea } from "../../ui/CodeArea";
import { Dialog } from "../../ui/Dialog";
import { NumberField } from "../../ui/NumberField";
import { Select } from "../../ui/Select";
import { TextField } from "../../ui/TextField";
import { OAUTH2_PROVIDERS } from "../oauth2-providers";
import { groupClass } from "./opts";

export type Provider = Record<string, unknown> & { name: string };

const APPLE_MAX_DURATION = 15777000;

function Input({
  label,
  path,
  value,
  onChange,
  hint,
  type,
  required,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <TextField
      label={label}
      hint={hint}
      type={type}
      required={required}
      value={value}
      error={useFieldError(path)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ProviderDialog({
  provider,
  errorPath,
  onCancel,
  onSave,
}: {
  provider: Provider;
  errorPath: string;
  onCancel: () => void;
  onSave: (provider: Provider) => void;
}) {
  const info = OAUTH2_PROVIDERS.find((p) => p.name === provider.name);
  const text = (key: string) => String(provider[key] ?? "");
  const [form, setForm] = useState({
    clientId: text("clientId"),
    clientSecret: "",
    displayName: text("displayName"),
    authURL: text("authURL"),
    tokenURL: text("tokenURL"),
    userInfoURL: text("userInfoURL"),
  });
  const [pkce, setPkce] = useState(
    provider.pkce === true ? "on" : provider.pkce === false ? "off" : "unset",
  );
  const field = (key: keyof typeof form, label: string, extra = {}) => (
    <Input
      label={label}
      path={`${errorPath}.${key}`}
      value={form[key]}
      onChange={(v) => setForm({ ...form, [key]: v })}
      {...extra}
    />
  );

  const save = () => {
    const { clientSecret, ...rest } = form;
    onSave({
      ...provider,
      ...rest,
      pkce: pkce === "on" ? true : pkce === "off" ? false : null,
      ...(clientSecret ? { clientSecret } : {}),
    });
  };

  const urls = (
    <>
      {field("authURL", "Auth URL", { type: "url", required: info?.needsURLs })}
      {field("tokenURL", "Token URL", {
        type: "url",
        required: info?.needsURLs,
      })}
      {field("userInfoURL", "User info URL", {
        type: "url",
        required: info?.needsURLs,
      })}
    </>
  );

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`${info?.displayName ?? provider.name} provider`}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" onClick={save}>
            Save provider
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {field("clientId", "Client ID")}
        {field("clientSecret", "Client secret", {
          type: "password",
          hint:
            "clientId" in provider
              ? "Leave empty to keep the current value"
              : undefined,
        })}
        {provider.name === "apple" && (
          <fieldset className={groupClass}>
            <legend className="px-1 text-sm font-medium">
              Generate client secret
            </legend>
            <AppleSecret
              clientId={form.clientId}
              onSecret={(clientSecret) =>
                setForm((f) => ({ ...f, clientSecret }))
              }
            />
          </fieldset>
        )}
        {field("displayName", "Display name")}
        <Select
          label="PKCE"
          value={pkce}
          onChange={(e) => setPkce(e.target.value)}
        >
          <option value="unset">Provider default</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </Select>
        {info?.needsURLs ? (
          urls
        ) : (
          <details>
            <summary className="cursor-pointer text-sm">
              Custom endpoints
            </summary>
            <div className="mt-2 flex flex-col gap-3">{urls}</div>
          </details>
        )}
      </div>
    </Dialog>
  );
}

function AppleSecret({
  clientId,
  onSecret,
}: {
  clientId: string;
  onSecret: (secret: string) => void;
}) {
  const client = useClient();
  const [form, setForm] = useState({
    teamId: "",
    keyId: "",
    privateKey: "",
    duration: APPLE_MAX_DURATION,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { secret } = await client.settings.generateAppleClientSecret(
        clientId,
        form.teamId,
        form.keyId,
        form.privateKey,
        form.duration,
      );
      onSecret(secret);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ErrorScope error={error}>
      <UnclaimedErrors />
      <Input
        label="Team ID"
        path="teamId"
        value={form.teamId}
        onChange={(teamId) => setForm({ ...form, teamId })}
      />
      <Input
        label="Key ID"
        path="keyId"
        value={form.keyId}
        onChange={(keyId) => setForm({ ...form, keyId })}
      />
      <PrivateKey
        value={form.privateKey}
        onChange={(privateKey) => setForm({ ...form, privateKey })}
      />
      <Duration
        value={form.duration}
        onChange={(duration) => setForm({ ...form, duration })}
      />
      <Button
        className="self-start"
        loading={busy}
        onClick={() => void generate()}
      >
        Generate client secret
      </Button>
    </ErrorScope>
  );
}

function PrivateKey(p: { value: string; onChange: (v: string) => void }) {
  return (
    <CodeArea
      label="Private key"
      rows={4}
      value={p.value}
      error={useFieldError("privateKey")}
      onChange={p.onChange}
    />
  );
}

function Duration(p: { value: number; onChange: (v: number) => void }) {
  return (
    <NumberField
      label="Duration (seconds)"
      max={APPLE_MAX_DURATION}
      value={p.value}
      error={useFieldError("duration")}
      onChange={(e) => p.onChange(Number(e.target.value))}
    />
  );
}
