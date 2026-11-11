import { useFieldError } from "../../app/errors";
import { Checkbox } from "../../ui/Checkbox";
import { NumberField } from "../../ui/NumberField";
import { TextField } from "../../ui/TextField";
import type { CollectionDraft } from "../editor-state";

type Obj = Record<string, unknown>;

export function getIn(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (o as Obj | undefined)?.[k], obj);
}

export function setIn<T extends Obj>(
  obj: T,
  path: string[],
  value: unknown,
): T {
  const [head, ...rest] = path as [string, ...string[]];
  const child = (obj[head] ?? {}) as Obj;
  return { ...obj, [head]: rest.length ? setIn(child, rest, value) : value };
}

export interface OptCtx {
  draft: CollectionDraft;
  set: (path: string[], value: unknown) => void;
  // For changes that shift list indexes, so index-based server errors are cleared.
  reshape: (path: string[], value: unknown) => void;
}

interface OptProps {
  c: OptCtx;
  path: string[];
  label: string;
  hint?: string;
}

export function TextOpt({ c, path, label, hint }: OptProps) {
  return (
    <TextField
      label={label}
      hint={hint}
      value={String(getIn(c.draft, path) ?? "")}
      error={useFieldError(path.join("."))}
      onChange={(e) => c.set(path, e.target.value)}
    />
  );
}

export function NumOpt({ c, path, label, hint }: OptProps) {
  const value = getIn(c.draft, path);
  return (
    <NumberField
      label={label}
      hint={hint}
      value={typeof value === "number" ? value : ""}
      error={useFieldError(path.join("."))}
      onChange={(e) =>
        c.set(path, e.target.value === "" ? 0 : Number(e.target.value))
      }
    />
  );
}

export function BoolOpt({ c, path, label, hint }: OptProps) {
  return (
    <Checkbox
      label={label}
      hint={hint}
      checked={getIn(c.draft, path) === true}
      error={useFieldError(path.join("."))}
      onChange={(e) => c.set(path, e.target.checked)}
    />
  );
}

export const groupClass =
  "flex flex-col gap-2 rounded border border-slate-200 p-3 dark:border-slate-700";
