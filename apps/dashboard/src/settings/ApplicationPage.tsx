import type { ReactNode } from "react";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../app/errors";
import { Button, Section } from "@heybe/ui";
import {
  CheckInput,
  IntInput,
  LinesInput,
  NumberInput,
  TextInput,
} from "./inputs";
import {
  useSettings,
  type RateLimitRule,
  type SettingsModel,
} from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function ApplicationPage() {
  const settings = useSettings();
  if (!settings.data) return null;
  return <ApplicationForm settings={settings.data} />;
}

function ApplicationForm({ settings }: { settings: SettingsModel }) {
  const { form, version, save, submit, reset } = useSettingsForm(settings);

  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
        <Section title="Application">
          <form.Field name="settings.meta.appName">
            {(field) => (
              <TextInput
                path="meta.appName"
                label="Application name"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.meta.appURL">
            {(field) => (
              <TextInput
                path="meta.appURL"
                label="Application URL"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.meta.accentColor">
            {(field) => (
              <TextInput
                path="meta.accentColor"
                label="Accent color"
                type="color"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.meta.hideControls">
            {(field) => (
              <CheckInput
                path="meta.hideControls"
                label="Hide collection controls"
                field={field}
              />
            )}
          </form.Field>
        </Section>
        <Section title="Access">
          <form.Field name="settings.superuserIPs">
            {(field) => (
              <LinesInput
                path="superuserIPs"
                label="Superuser IPs"
                hint="Leave empty to allow any IP."
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.trustedProxy.headers">
            {(field) => (
              <LinesInput
                path="trustedProxy.headers"
                label="Trusted proxy"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.trustedProxy.useLeftmostIP">
            {(field) => (
              <CheckInput
                path="trustedProxy.useLeftmostIP"
                label="Use leftmost IP"
                field={field}
              />
            )}
          </form.Field>
        </Section>
        <Section title="Rate limits">
          <form.Field name="settings.rateLimits.enabled">
            {(field) => (
              <CheckInput
                path="rateLimits.enabled"
                label="Enable rate limits"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.rateLimits.rules">
            {(field) => (
              <RulesTable
                rules={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="settings.rateLimits.excludedIPs">
            {(field) => (
              <LinesInput
                path="rateLimits.excludedIPs"
                label="Excluded IPs"
                field={field}
              />
            )}
          </form.Field>
        </Section>
        <Section title="Batch API">
          <form.Field name="settings.batch.enabled">
            {(field) => (
              <CheckInput
                path="batch.enabled"
                label="Enable batch API"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.batch.maxRequests">
            {(field) => (
              <NumberInput
                path="batch.maxRequests"
                label="Max requests"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.batch.timeout">
            {(field) => (
              <NumberInput
                path="batch.timeout"
                label="Timeout (seconds)"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.batch.maxBodySize">
            {(field) => (
              <NumberInput
                path="batch.maxBodySize"
                label="Max body size (bytes)"
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
        </div>
      </form>
    </ErrorScope>
  );
}

const emptyRule: RateLimitRule = {
  label: "",
  audience: "",
  duration: 1,
  maxRequests: 1,
};

function RulesTable({
  rules,
  onChange,
}: {
  rules: RateLimitRule[];
  onChange(rules: RateLimitRule[]): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">Audience</th>
            <th scope="col">Max requests</th>
            <th scope="col">Duration (seconds)</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule, i) => (
            <RuleRow
              key={i}
              index={i}
              rule={rule}
              onChange={(next) =>
                onChange(rules.map((r, j) => (j === i ? next : r)))
              }
              onRemove={() => onChange(rules.filter((_, j) => j !== i))}
            />
          ))}
        </tbody>
      </table>
      <Button
        className="self-start"
        onClick={() => onChange([...rules, { ...emptyRule }])}
      >
        Add rule
      </Button>
    </div>
  );
}

function RuleRow({
  index,
  rule,
  onChange,
  onRemove,
}: {
  index: number;
  rule: RateLimitRule;
  onChange(rule: RateLimitRule): void;
  onRemove(): void;
}) {
  const base = `rateLimits.rules.${index}`;
  const errors = {
    label: useFieldError(`${base}.label`),
    audience: useFieldError(`${base}.audience`),
    maxRequests: useFieldError(`${base}.maxRequests`),
    duration: useFieldError(`${base}.duration`),
  };
  const cell = (
    key: keyof typeof errors,
    input: (describedBy: string | undefined) => ReactNode,
  ) => {
    const errorId = `${base}.${key}-error`;
    return (
      <td className="p-1 align-top">
        {input(errors[key] ? errorId : undefined)}
        {errors[key] && (
          <p id={errorId} className="text-xs text-red-600 dark:text-red-400">
            {errors[key]}
          </p>
        )}
      </td>
    );
  };
  const inputProps = (key: keyof typeof errors, describedBy?: string) => ({
    "aria-invalid": errors[key] ? (true as const) : undefined,
    "aria-describedby": describedBy,
    className:
      "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800",
  });
  return (
    <tr>
      {cell("label", (d) => (
        <input
          aria-label="Label"
          value={rule.label}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
          {...inputProps("label", d)}
        />
      ))}
      {cell("audience", (d) => (
        <select
          aria-label="Audience"
          value={rule.audience}
          onChange={(e) => onChange({ ...rule, audience: e.target.value })}
          {...inputProps("audience", d)}
        >
          <option value="">All</option>
          <option value="@guest">@guest</option>
          <option value="@auth">@auth</option>
        </select>
      ))}
      {cell("maxRequests", (d) => (
        <IntInput
          aria-label="Max requests"
          value={rule.maxRequests}
          onChange={(maxRequests) => onChange({ ...rule, maxRequests })}
          {...inputProps("maxRequests", d)}
        />
      ))}
      {cell("duration", (d) => (
        <IntInput
          aria-label="Duration (seconds)"
          value={rule.duration}
          onChange={(duration) => onChange({ ...rule, duration })}
          {...inputProps("duration", d)}
        />
      ))}
      <td className="p-1 align-top">
        <Button onClick={onRemove}>Remove rule {index + 1}</Button>
      </td>
    </tr>
  );
}
