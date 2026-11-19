import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../../app/context";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../../app/errors";
import {
  Button,
  CodeArea,
  Dialog,
  Disclosure,
  NumberField,
  Select,
  TextField,
} from "@heybe/ui";
import type { Provider } from "../editor-state";
import { OAUTH2_PROVIDERS } from "../oauth2-providers";
import { groupClass } from "./opts";

const APPLE_MAX_DURATION = 15777000;

function Input({
  label,
  path,
  value,
  onChange,
  hint,
  type,
  required,
  error,
}: {
  label: string;
  path: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  type?: string;
  required?: boolean;
  error?: string;
}) {
  const serverError = useFieldError(path);
  return (
    <TextField
      label={label}
      hint={hint}
      type={type}
      required={required}
      value={value}
      error={error ?? serverError}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ProviderDialog({
  provider,
  errorPath,
  onCancel,
  onSave,
  submitLabel = "Apply",
}: {
  provider: Provider;
  errorPath: string;
  onCancel: () => void;
  onSave: (provider: Provider) => void;
  submitLabel?: string;
}) {
  const info = OAUTH2_PROVIDERS.find((p) => p.name === provider.name);
  const hasSecret = Boolean(provider.clientId);
  const [blank, setBlank] = useState<{
    clientId?: string;
    clientSecret?: string;
  }>({});
  const text = (key: string) => String(provider[key] ?? "");
  const form = useForm({
    defaultValues: {
      clientId: text("clientId"),
      clientSecret: "",
      displayName: text("displayName"),
      authURL: text("authURL"),
      tokenURL: text("tokenURL"),
      userInfoURL: text("userInfoURL"),
      pkce:
        provider.pkce === true
          ? "on"
          : provider.pkce === false
            ? "off"
            : "unset",
    },
    onSubmit: ({ value: { clientSecret, pkce, ...rest } }) => {
      const missing = {
        clientId: rest.clientId.trim() ? undefined : "Cannot be blank.",
        clientSecret:
          clientSecret || hasSecret ? undefined : "Cannot be blank.",
      };
      setBlank(missing);
      if (missing.clientId || missing.clientSecret) return;
      onSave({
        ...provider,
        ...rest,
        pkce: pkce === "on" ? true : pkce === "off" ? false : null,
        ...(clientSecret ? { clientSecret } : {}),
      });
    },
  });
  type Key = Exclude<keyof typeof form.state.values, "pkce">;
  const field = (key: Key, label: string, extra = {}) => (
    <form.Field name={key}>
      {(f) => (
        <Input
          label={label}
          path={`${errorPath}.${key}`}
          value={f.state.value}
          onChange={(value) => {
            f.handleChange(value);
            setBlank((b) => ({ ...b, [key]: undefined }));
          }}
          error={blank[key as keyof typeof blank]}
          {...extra}
        />
      )}
    </form.Field>
  );

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
          <Button variant="primary" onClick={() => void form.handleSubmit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <UnclaimedErrors />
        {field("clientId", "Client ID")}
        {field("clientSecret", "Client secret", {
          type: "password",
          hint: hasSecret ? "Leave empty to keep the current value" : undefined,
        })}
        {provider.name === "apple" && (
          <fieldset className={groupClass}>
            <legend className="px-1 text-sm font-medium">
              Generate client secret
            </legend>
            <AppleSecret
              clientId={() => form.state.values.clientId}
              onSecret={(secret) => form.setFieldValue("clientSecret", secret)}
            />
          </fieldset>
        )}
        {field("displayName", "Display name")}
        <form.Field name="pkce">
          {(f) => (
            <Select
              label="PKCE"
              value={f.state.value}
              onChange={(e) => f.handleChange(e.target.value)}
            >
              <option value="unset">Provider default</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
          )}
        </form.Field>
        {info?.needsURLs ? (
          urls
        ) : (
          <Disclosure title="Custom endpoints">
            <div className="flex flex-col gap-3">{urls}</div>
          </Disclosure>
        )}
      </div>
    </Dialog>
  );
}

function AppleSecret({
  clientId,
  onSecret,
}: {
  clientId: () => string;
  onSecret: (secret: string) => void;
}) {
  const client = useClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({
    defaultValues: {
      teamId: "",
      keyId: "",
      privateKey: "",
      duration: APPLE_MAX_DURATION,
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const { secret } = await client.settings.generateAppleClientSecret(
          clientId(),
          value.teamId,
          value.keyId,
          value.privateKey,
          value.duration,
        );
        onSecret(secret);
      } catch (err) {
        setError(err);
      }
    },
  });

  return (
    <ErrorScope error={error}>
      <UnclaimedErrors />
      <form.Field name="teamId">
        {(f) => (
          <Input
            label="Team ID"
            path="teamId"
            value={f.state.value}
            onChange={f.handleChange}
          />
        )}
      </form.Field>
      <form.Field name="keyId">
        {(f) => (
          <Input
            label="Key ID"
            path="keyId"
            value={f.state.value}
            onChange={f.handleChange}
          />
        )}
      </form.Field>
      <form.Field name="privateKey">
        {(f) => <PrivateKey value={f.state.value} onChange={f.handleChange} />}
      </form.Field>
      <form.Field name="duration">
        {(f) => <Duration value={f.state.value} onChange={f.handleChange} />}
      </form.Field>
      <form.Subscribe selector={(s) => s.isSubmitting}>
        {(isSubmitting) => (
          <Button
            className="self-start"
            loading={isSubmitting}
            onClick={() => void form.handleSubmit()}
          >
            Generate client secret
          </Button>
        )}
      </form.Subscribe>
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
