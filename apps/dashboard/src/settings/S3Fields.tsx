import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, useToast } from "@heybe/ui";
import {
  DependentFields,
  EnabledBadge,
  SectionDisclosure,
  SecretInput,
  SwitchInput,
  TextInput,
} from "./inputs";
import type { SettingsForm } from "./use-settings-form";

export function S3Fields({
  form,
  prefix,
}: {
  form: SettingsForm;
  prefix: "s3" | "backups.s3";
}) {
  const secret =
    prefix === "s3" ? "secrets.s3Secret" : "secrets.backupsS3Secret";
  return (
    <form.Subscribe
      selector={(s) =>
        prefix === "s3"
          ? s.values.settings.s3.enabled
          : s.values.settings.backups.s3.enabled
      }
    >
      {(enabled) => (
        <SectionDisclosure
          errorPrefix={`${prefix}.`}
          title="S3 storage"
          badge={<EnabledBadge on={enabled} />}
        >
          <div className="flex flex-col gap-3">
            <form.Field name={`settings.${prefix}.enabled`}>
              {(field) => (
                <SwitchInput
                  path={`${prefix}.enabled`}
                  label="Use S3 storage"
                  field={field}
                />
              )}
            </form.Field>
            <DependentFields enabled={enabled}>
              <form.Field name={`settings.${prefix}.endpoint`}>
                {(field) => (
                  <TextInput
                    path={`${prefix}.endpoint`}
                    label="Endpoint"
                    field={field}
                  />
                )}
              </form.Field>
              <form.Field name={`settings.${prefix}.bucket`}>
                {(field) => (
                  <TextInput
                    path={`${prefix}.bucket`}
                    label="Bucket"
                    field={field}
                  />
                )}
              </form.Field>
              <form.Field name={`settings.${prefix}.region`}>
                {(field) => (
                  <TextInput
                    path={`${prefix}.region`}
                    label="Region"
                    field={field}
                  />
                )}
              </form.Field>
              <form.Field name={`settings.${prefix}.accessKey`}>
                {(field) => (
                  <TextInput
                    path={`${prefix}.accessKey`}
                    label="Access key"
                    field={field}
                  />
                )}
              </form.Field>
              <form.Field name={secret}>
                {(field) => (
                  <SecretInput
                    path={`${prefix}.secret`}
                    label="Secret"
                    field={field}
                  />
                )}
              </form.Field>
              <form.Field name={`settings.${prefix}.forcePathStyle`}>
                {(field) => (
                  <SwitchInput
                    path={`${prefix}.forcePathStyle`}
                    label="Force path style"
                    field={field}
                  />
                )}
              </form.Field>
            </DependentFields>
          </div>
        </SectionDisclosure>
      )}
    </form.Subscribe>
  );
}

export function TestS3Button({
  filesystem,
  disabled,
}: {
  filesystem: "storage" | "backups";
  disabled: boolean;
}) {
  const client = useClient();
  const toast = useToast();
  const test = async () => {
    try {
      await client.settings.testS3(filesystem);
      toast.success("Connection works.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Button
      className="self-start"
      disabled={disabled}
      onClick={() => void test()}
    >
      Test connection
    </Button>
  );
}
