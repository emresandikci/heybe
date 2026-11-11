import { ErrorScope, UnclaimedErrors } from "../app/errors";
import { Button } from "../ui/Button";
import { S3Fields, TestS3Button } from "./S3Fields";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";
import { Section } from "../ui/Section";

export function StoragePage() {
  const settings = useSettings();
  if (!settings.data) return null;
  return <StorageForm settings={settings.data} />;
}

function StorageForm({ settings }: { settings: SettingsModel }) {
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
        <Section title="File storage">
          <p className="text-sm">
            Existing files are not moved when you switch storage.
          </p>
          <S3Fields form={form} prefix="s3" />
          <TestS3Button filesystem="storage" disabled={dirty} />
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
