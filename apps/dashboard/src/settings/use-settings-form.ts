import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useToast } from "../ui/Toasts";
import {
  changedSections,
  useSaveSettings,
  type SettingsModel,
} from "./use-settings";

const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

const emptySecrets = { smtpPassword: "", s3Secret: "", backupsS3Secret: "" };

const secretPaths: Record<keyof typeof emptySecrets, string> = {
  smtpPassword: "smtp.password",
  s3Secret: "s3.secret",
  backupsS3Secret: "backups.s3.secret",
};

const initial = (settings: SettingsModel) => ({
  settings,
  secrets: emptySecrets,
});

export function useSettingsForm(settings: SettingsModel, onSaved?: () => void) {
  const toast = useToast();
  const save = useSaveSettings();
  const [version, setVersion] = useState(0);

  const load = (next: SettingsModel) => {
    loaded.current = next;
    form.reset(initial(next), { keepDefaultValues: true });
    setVersion((v) => v + 1);
  };

  const [initial0] = useState(() => initial(settings));
  const loaded = useRef(settings);
  const form = useForm({
    defaultValues: initial0,
    onSubmit: ({ value }) => {
      const payload: Record<string, any> = changedSections(
        settings,
        value.settings,
      );
      for (const [name, path] of Object.entries(secretPaths)) {
        const secret = value.secrets[name as keyof typeof emptySecrets];
        if (!secret) continue;
        const keys = path.split(".");
        payload[keys[0]!] ??= structuredClone(
          value.settings[keys[0] as keyof SettingsModel],
        );
        let node = payload[keys[0]!];
        for (const key of keys.slice(1, -1)) node = node[key];
        node[keys.at(-1)!] = secret;
      }
      save.mutate(payload, {
        onSuccess: (saved) => {
          load(saved);
          toast.success("Settings saved.");
          onSaved?.();
        },
      });
    },
  });

  const dirty = useStore(
    form.store,
    (s) =>
      !same(s.values.settings, settings) ||
      Object.values(s.values.secrets).some(Boolean),
  );

  useEffect(() => {
    if (!dirty && !same(settings, loaded.current)) load(settings);
  }, [settings]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void form.handleSubmit();
  };

  const reset = () => {
    save.reset();
    load(settings);
  };

  return { form, dirty, version, save, submit, reset };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>["form"];
