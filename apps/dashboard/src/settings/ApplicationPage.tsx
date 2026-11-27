import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorScope, useFieldError } from "../app/errors";
import { Button, Select, Table, Td, TextField, Th } from "@heybejs/ui";
import {
  DependentFields,
  EnabledBadge,
  SectionDisclosure,
  IntInput,
  ListInput,
  NumberInput,
  SwitchInput,
  TextInput,
} from "./inputs";
import { QueryStatus } from "./QueryStatus";
import { FormFooter } from "./FormFooter";
import { SettingsPage } from "./SettingsPage";
import {
  useSettings,
  type RateLimitRule,
  type SettingsModel,
} from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function ApplicationPage() {
  const settings = useSettings();
  return (
    <SettingsPage title="Application">
      {settings.data ? (
        <ApplicationForm settings={settings.data} />
      ) : (
        <QueryStatus query={settings} />
      )}
    </SettingsPage>
  );
}

function ApplicationForm({ settings }: { settings: SettingsModel }) {
  const { form, dirty, save, submit, reset } = useSettingsForm(settings);

  return (
    <ErrorScope error={save.error}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
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
        </div>
        <form.Field name="settings.meta.hideControls">
          {(field) => (
            <SwitchInput
              path="meta.hideControls"
              label="Hide collection controls"
              field={field}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.values.settings.batch.enabled}>
          {(enabled) => (
            <SectionDisclosure
              errorPrefix="batch."
              title="Batch API"
              badge={<EnabledBadge on={enabled} />}
            >
              <div className="flex flex-col gap-3">
                <form.Field name="settings.batch.enabled">
                  {(field) => (
                    <SwitchInput
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
              </div>
            </SectionDisclosure>
          )}
        </form.Subscribe>
        <form.Subscribe
          selector={(s) => s.values.settings.trustedProxy.headers.length > 0}
        >
          {(enabled) => (
            <SectionDisclosure
              errorPrefix="trustedProxy."
              title="IP proxy headers"
              badge={<EnabledBadge on={enabled} />}
            >
              <div className="flex flex-col gap-3">
                <form.Field name="settings.trustedProxy.headers">
                  {(field) => (
                    <ListInput
                      path="trustedProxy.headers"
                      label="Trusted proxy headers"
                      hint="Headers such as X-Forwarded-For."
                      field={field}
                    />
                  )}
                </form.Field>
                <form.Field name="settings.trustedProxy.useLeftmostIP">
                  {(field) => (
                    <SwitchInput
                      path="trustedProxy.useLeftmostIP"
                      label="Use leftmost IP"
                      field={field}
                    />
                  )}
                </form.Field>
              </div>
            </SectionDisclosure>
          )}
        </form.Subscribe>
        <form.Subscribe selector={(s) => s.values.settings.rateLimits.enabled}>
          {(enabled) => (
            <SectionDisclosure
              errorPrefix="rateLimits."
              title="Rate limiting"
              badge={<EnabledBadge on={enabled} />}
            >
              <div className="flex flex-col gap-3">
                <form.Field name="settings.rateLimits.enabled">
                  {(field) => (
                    <SwitchInput
                      path="rateLimits.enabled"
                      label="Enable rate limits"
                      field={field}
                    />
                  )}
                </form.Field>
                <DependentFields enabled={enabled}>
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
                      <ListInput
                        path="rateLimits.excludedIPs"
                        label="Excluded IPs"
                        disabled={!enabled}
                        field={field}
                      />
                    )}
                  </form.Field>
                </DependentFields>
              </div>
            </SectionDisclosure>
          )}
        </form.Subscribe>
        <form.Subscribe
          selector={(s) => s.values.settings.superuserIPs.length > 0}
        >
          {(enabled) => (
            <SectionDisclosure
              errorPrefix="superuserIPs"
              title="Superuser IPs"
              badge={<EnabledBadge on={enabled} />}
            >
              <form.Field name="settings.superuserIPs">
                {(field) => (
                  <ListInput
                    path="superuserIPs"
                    label="Allowed IPs"
                    hint="Leave empty to allow any IP."
                    field={field}
                  />
                )}
              </form.Field>
            </SectionDisclosure>
          )}
        </form.Subscribe>
        <FormFooter dirty={dirty} saving={save.isPending} onReset={reset} />
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
      <Table caption="Rate limit rules">
        <colgroup>
          <col />
          <col className="w-28" />
          <col className="w-32" />
          <col className="w-36" />
          <col className="w-12" />
        </colgroup>
        <thead>
          <tr>
            <Th>Label</Th>
            <Th>Audience</Th>
            <Th>Max requests</Th>
            <Th>Duration (seconds)</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
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
      </Table>
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
  const cell = (children: ReactNode) => (
    <Td>
      <div className="[&_label]:sr-only">{children}</div>
    </Td>
  );
  return (
    <tr>
      {cell(
        <TextField
          label="Label"
          value={rule.label}
          error={useFieldError(`${base}.label`)}
          onChange={(e) => onChange({ ...rule, label: e.target.value })}
        />,
      )}
      {cell(
        <Select
          label="Audience"
          value={rule.audience}
          error={useFieldError(`${base}.audience`)}
          onChange={(e) => onChange({ ...rule, audience: e.target.value })}
        >
          <option value="">All</option>
          <option value="@guest">@guest</option>
          <option value="@auth">@auth</option>
        </Select>,
      )}
      {cell(
        <IntInput
          label="Max requests"
          value={rule.maxRequests}
          error={useFieldError(`${base}.maxRequests`)}
          onChange={(maxRequests) => onChange({ ...rule, maxRequests })}
        />,
      )}
      {cell(
        <IntInput
          label="Duration (seconds)"
          value={rule.duration}
          error={useFieldError(`${base}.duration`)}
          onChange={(duration) => onChange({ ...rule, duration })}
        />,
      )}
      <Td>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove rule ${index + 1}`}
          icon={<Trash2 size={15} strokeWidth={1.75} />}
          onClick={onRemove}
        />
      </Td>
    </tr>
  );
}
