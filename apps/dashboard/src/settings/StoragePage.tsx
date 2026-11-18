import { ErrorScope } from "../app/errors";
import { FormFooter } from "./FormFooter";
import { QueryStatus } from "./QueryStatus";
import { S3Fields, TestS3Button } from "./S3Fields";
import { SettingsPage } from "./SettingsPage";
import { useSettings, type SettingsModel } from "./use-settings";
import { useSettingsForm } from "./use-settings-form";

export function StoragePage() {
  const settings = useSettings();
  return (
    <SettingsPage title="File storage">
      {settings.data ? (
        <StorageForm settings={settings.data} />
      ) : (
        <QueryStatus query={settings} />
      )}
    </SettingsPage>
  );
}

function StorageForm({ settings }: { settings: SettingsModel }) {
  const { form, dirty, save, submit, reset } = useSettingsForm(settings);
  return (
    <ErrorScope error={save.error}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Existing files are not moved when you switch storage.
        </p>
        <S3Fields form={form} prefix="s3" />
        <TestS3Button filesystem="storage" disabled={dirty} />
        <FormFooter dirty={dirty} saving={save.isPending} onReset={reset} />
      </form>
    </ErrorScope>
  );
}
