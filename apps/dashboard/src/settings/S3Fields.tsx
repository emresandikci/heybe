import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toasts";
import { CheckInput, SecretInput, TextInput } from "./inputs";
import type { S3Config } from "./use-settings";

export function S3Fields({
  value,
  onChange,
  secret,
  onSecretChange,
  prefix,
}: {
  value: S3Config;
  onChange(patch: Partial<S3Config>): void;
  secret: string;
  onSecretChange(value: string): void;
  prefix: "s3" | "backups.s3";
}) {
  return (
    <>
      <CheckInput
        path={`${prefix}.enabled`}
        label="Use S3 storage"
        checked={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
      <TextInput
        path={`${prefix}.endpoint`}
        label="Endpoint"
        value={value.endpoint}
        onChange={(endpoint) => onChange({ endpoint })}
      />
      <TextInput
        path={`${prefix}.bucket`}
        label="Bucket"
        value={value.bucket}
        onChange={(bucket) => onChange({ bucket })}
      />
      <TextInput
        path={`${prefix}.region`}
        label="Region"
        value={value.region}
        onChange={(region) => onChange({ region })}
      />
      <TextInput
        path={`${prefix}.accessKey`}
        label="Access key"
        value={value.accessKey}
        onChange={(accessKey) => onChange({ accessKey })}
      />
      <SecretInput
        path={`${prefix}.secret`}
        label="Secret"
        value={secret}
        onChange={onSecretChange}
      />
      <CheckInput
        path={`${prefix}.forcePathStyle`}
        label="Force path style"
        checked={value.forcePathStyle}
        onChange={(forcePathStyle) => onChange({ forcePathStyle })}
      />
    </>
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
    <Button disabled={disabled} onClick={() => void test()}>
      Test connection
    </Button>
  );
}
