import { ErrorScope, UnclaimedErrors, useFieldError } from "../app/errors";
import { CheckInput, NumberInput } from "../settings/inputs";
import type { SettingsModel } from "../settings/use-settings";
import { useSettingsForm } from "../settings/use-settings-form";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { levelName } from "./level";

export function LogsSettingsDialog({
  settings,
  onClose,
}: {
  settings: SettingsModel;
  onClose(): void;
}) {
  const { form, save, submit } = useSettingsForm(settings, onClose);
  return (
    <ErrorScope error={save.error}>
      <Dialog open onClose={onClose} title="Logs settings">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <UnclaimedErrors />
          <form.Field name="settings.logs.maxDays">
            {(field) => (
              <NumberInput
                path="logs.maxDays"
                label="Retention (days)"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.logs.minLevel">
            {(field) => (
              <MinLevel
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="settings.logs.logIP">
            {(field) => (
              <CheckInput
                path="logs.logIP"
                label="Log IP addresses"
                field={field}
              />
            )}
          </form.Field>
          <form.Field name="settings.logs.logAuthId">
            {(field) => (
              <CheckInput
                path="logs.logAuthId"
                label="Log authenticated user ids"
                field={field}
              />
            )}
          </form.Field>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={save.isPending}>
              Save changes
            </Button>
          </div>
        </form>
      </Dialog>
    </ErrorScope>
  );
}

function MinLevel({
  value,
  onChange,
}: {
  value: number;
  onChange(value: number): void;
}) {
  const levels = [-4, 0, 4, 8];
  if (!levels.includes(value)) levels.push(value);
  return (
    <Select
      label="Min level"
      value={value}
      error={useFieldError("logs.minLevel")}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {levels.map((level) => (
        <option key={level} value={level}>
          {levelName(level)}
        </option>
      ))}
    </Select>
  );
}
