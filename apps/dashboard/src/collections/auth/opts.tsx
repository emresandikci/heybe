import type { DeepKeysOfType } from "@tanstack/react-form";
import { useFieldError } from "../../app/errors";
import { Checkbox, NumberField, TextField } from "@heybe/ui";
import type { CollectionDraft, EditorForm } from "../editor-state";

export function getIn(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      obj,
    );
}

// Auth option groups are missing on base and view drafts, so their values may be undefined.
export type OptPath<T> = DeepKeysOfType<CollectionDraft, T | undefined>;

export interface OptCtx {
  form: EditorForm;
  draft: CollectionDraft;
  // For changes that shift list indexes, so index-based server errors are cleared.
  clearError: () => void;
}

interface OptProps<T> {
  c: OptCtx;
  path: OptPath<T>;
  label: string;
  hint?: string;
}

export function TextOpt({ c, path, label, hint }: OptProps<string>) {
  const error = useFieldError(path);
  return (
    <c.form.Field name={path}>
      {(field) => (
        <TextField
          label={label}
          hint={hint}
          value={field.state.value ?? ""}
          error={error}
          onChange={(e) => field.handleChange(e.target.value)}
        />
      )}
    </c.form.Field>
  );
}

export function NumOpt({ c, path, label, hint }: OptProps<number>) {
  const error = useFieldError(path);
  return (
    <c.form.Field name={path}>
      {(field) => (
        <NumberField
          label={label}
          hint={hint}
          value={field.state.value ?? ""}
          error={error}
          onChange={(e) =>
            field.handleChange(
              e.target.value === "" ? 0 : Number(e.target.value),
            )
          }
        />
      )}
    </c.form.Field>
  );
}

export function BoolOpt({ c, path, label, hint }: OptProps<boolean>) {
  const error = useFieldError(path);
  return (
    <c.form.Field name={path}>
      {(field) => (
        <Checkbox
          label={label}
          hint={hint}
          checked={field.state.value === true}
          error={error}
          onChange={(e) => field.handleChange(e.target.checked)}
        />
      )}
    </c.form.Field>
  );
}

export const groupClass =
  "flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700";
