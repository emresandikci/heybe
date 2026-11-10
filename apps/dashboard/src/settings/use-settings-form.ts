import { useState, type FormEvent } from "react";
import { useToast } from "../ui/Toasts";
import {
  changedSections,
  useSaveSettings,
  type SettingsModel,
} from "./use-settings";

const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

export function useSettingsForm(settings: SettingsModel) {
  const toast = useToast();
  const save = useSaveSettings();
  const [base, setBase] = useState(settings);
  const [draft, setDraft] = useState(settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const typed = Object.entries(secrets).filter(([, value]) => value);
  const dirty = !same(draft, base) || typed.length > 0;

  const load = (next: SettingsModel) => {
    setBase(next);
    setDraft(next);
    setSecrets({});
    setVersion((v) => v + 1);
  };
  if (!same(settings, base) && !dirty) load(settings);

  const set = <K extends keyof SettingsModel>(
    key: K,
    patch: Partial<SettingsModel[K]> | SettingsModel[K],
  ) =>
    setDraft((d) => ({
      ...d,
      [key]: Array.isArray(patch) ? patch : { ...d[key], ...patch },
    }));

  const setSecret = (path: string, value: string) =>
    setSecrets((s) => ({ ...s, [path]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const payload: Record<string, any> = changedSections(base, draft);
    for (const [path, value] of typed) {
      const keys = path.split(".");
      payload[keys[0]!] ??= structuredClone(
        draft[keys[0] as keyof SettingsModel],
      );
      let node = payload[keys[0]!];
      for (const key of keys.slice(1, -1)) node = node[key];
      node[keys.at(-1)!] = value;
    }
    save.mutate(payload, {
      onSuccess: (saved) => {
        load(saved);
        toast.success("Settings saved.");
      },
    });
  };

  const reset = () => {
    save.reset();
    load(base);
  };

  return {
    draft,
    set,
    secrets,
    setSecret,
    dirty,
    version,
    save,
    submit,
    reset,
  };
}
