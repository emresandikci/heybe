import type { ReactNode } from "react";
import { ErrorScope, UnclaimedErrors, useFieldError } from "../app/errors";
import { Button } from "../ui/Button";
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
import { Section } from "../ui/Section";

export function ApplicationPage() {
  const settings = useSettings();
  if (!settings.data) return null;
  return <ApplicationForm settings={settings.data} />;
}

function ApplicationForm({ settings }: { settings: SettingsModel }) {
  const { draft, set, version, save, submit, reset } =
    useSettingsForm(settings);

  const { meta, rateLimits, trustedProxy, batch } = draft;
  return (
    <ErrorScope error={save.error}>
      <form
        key={version}
        onSubmit={submit}
        className="flex max-w-2xl flex-col gap-4"
      >
        <UnclaimedErrors />
        <Section title="Application">
          <TextInput
            path="meta.appName"
            label="Application name"
            value={meta.appName}
            onChange={(appName) => set("meta", { appName })}
          />
          <TextInput
            path="meta.appURL"
            label="Application URL"
            value={meta.appURL}
            onChange={(appURL) => set("meta", { appURL })}
          />
          <TextInput
            path="meta.accentColor"
            label="Accent color"
            type="color"
            value={meta.accentColor}
            onChange={(accentColor) => set("meta", { accentColor })}
          />
          <CheckInput
            path="meta.hideControls"
            label="Hide collection controls"
            checked={meta.hideControls}
            onChange={(hideControls) => set("meta", { hideControls })}
          />
        </Section>
        <Section title="Access">
          <LinesInput
            path="superuserIPs"
            label="Superuser IPs"
            hint="Leave empty to allow any IP."
            value={draft.superuserIPs}
            onChange={(ips) => set("superuserIPs", ips)}
          />
          <LinesInput
            path="trustedProxy.headers"
            label="Trusted proxy"
            value={trustedProxy.headers}
            onChange={(headers) => set("trustedProxy", { headers })}
          />
          <CheckInput
            path="trustedProxy.useLeftmostIP"
            label="Use leftmost IP"
            checked={trustedProxy.useLeftmostIP}
            onChange={(useLeftmostIP) => set("trustedProxy", { useLeftmostIP })}
          />
        </Section>
        <Section title="Rate limits">
          <CheckInput
            path="rateLimits.enabled"
            label="Enable rate limits"
            checked={rateLimits.enabled}
            onChange={(enabled) => set("rateLimits", { enabled })}
          />
          <RulesTable
            rules={rateLimits.rules}
            onChange={(rules) => set("rateLimits", { rules })}
          />
          <LinesInput
            path="rateLimits.excludedIPs"
            label="Excluded IPs"
            value={rateLimits.excludedIPs}
            onChange={(excludedIPs) => set("rateLimits", { excludedIPs })}
          />
        </Section>
        <Section title="Batch API">
          <CheckInput
            path="batch.enabled"
            label="Enable batch API"
            checked={batch.enabled}
            onChange={(enabled) => set("batch", { enabled })}
          />
          <NumberInput
            path="batch.maxRequests"
            label="Max requests"
            value={batch.maxRequests}
            onChange={(maxRequests) => set("batch", { maxRequests })}
          />
          <NumberInput
            path="batch.timeout"
            label="Timeout (seconds)"
            value={batch.timeout}
            onChange={(timeout) => set("batch", { timeout })}
          />
          <NumberInput
            path="batch.maxBodySize"
            label="Max body size (bytes)"
            value={batch.maxBodySize}
            onChange={(maxBodySize) => set("batch", { maxBodySize })}
          />
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
