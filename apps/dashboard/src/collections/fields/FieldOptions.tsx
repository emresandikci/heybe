import { useEffect, useState } from "react";
import { useErrorsUnder, useFieldError } from "../../app/errors";
import { useCollections } from "../../app/queries";
import {
  Button,
  Checkbox,
  CodeArea,
  NumberField,
  Select,
  TextField,
} from "@heybe/ui";
import type { FieldModel } from "../editor-state";

export interface OptionsProps {
  field: FieldModel;
  errorPath: string;
  onChange: (patch: Partial<FieldModel>) => void;
}

interface OptionProps {
  p: OptionsProps;
  k: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

const MIME_PRESETS: Record<string, string[]> = {
  Images: [
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/gif",
    "image/webp",
  ],
  Documents: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
  ],
  Videos: ["video/mp4", "video/webm", "video/quicktime", "video/x-ms-wmv"],
  Archives: [
    "application/zip",
    "application/x-7z-compressed",
    "application/x-rar-compressed",
    "application/gzip",
  ],
};

const useError = (p: OptionsProps, k: string) =>
  useFieldError(`${p.errorPath}.${k}`);

function Text({ p, k, label, hint }: OptionProps) {
  return (
    <TextField
      label={label}
      hint={hint}
      value={String(p.field[k] ?? "")}
      error={useError(p, k)}
      onChange={(e) => p.onChange({ [k]: e.target.value })}
    />
  );
}

function Num({ p, k, label, nullable }: OptionProps & { nullable?: boolean }) {
  const value = p.field[k];
  return (
    <NumberField
      label={label}
      step={nullable ? "any" : undefined}
      value={typeof value === "number" ? value : ""}
      error={useError(p, k)}
      onChange={(e) =>
        p.onChange({
          [k]:
            e.target.value === ""
              ? nullable
                ? null
                : 0
              : Number(e.target.value),
        })
      }
    />
  );
}

function Bool({ p, k, label, disabled }: OptionProps) {
  return (
    <Checkbox
      label={label}
      checked={!!p.field[k]}
      disabled={disabled}
      error={useError(p, k)}
      onChange={(e) => p.onChange({ [k]: e.target.checked })}
    />
  );
}

function List({
  p,
  k,
  label,
  hint,
  disabled,
  lines,
}: OptionProps & { lines?: boolean }) {
  const value = (p.field[k] as string[] | undefined) ?? [];
  const separator = lines ? "\n" : ", ";
  const parse = (text: string) =>
    text
      .split(lines ? "\n" : ",")
      .map((s) => s.trim())
      .filter(Boolean);
  const [text, setText] = useState(value.join(separator));
  const joined = value.join("\n");
  useEffect(() => {
    setText((t) =>
      parse(t).join("\n") === joined ? t : value.join(separator),
    );
  }, [joined]);
  const items = useErrorsUnder(`${p.errorPath}.${k}.`);
  const error =
    useError(p, k) ??
    (items
      .map(([path, message]) => {
        const i = Number(path.slice(path.lastIndexOf(".") + 1));
        return `${value[i] ?? i}: ${message}`;
      })
      .join(" ") ||
      undefined);
  const change = (t: string) => {
    setText(t);
    p.onChange({ [k]: parse(t) });
  };
  return lines ? (
    <CodeArea
      label={label}
      hint={hint}
      rows={4}
      value={text}
      error={error}
      onChange={change}
    />
  ) : (
    <TextField
      label={label}
      hint={hint}
      value={text}
      disabled={disabled}
      error={error}
      onChange={(e) => change(e.target.value)}
    />
  );
}

function Multiple({ p, many }: { p: OptionsProps; many: () => number }) {
  const [multiple, setMultiple] = useState(Number(p.field.maxSelect) > 1);
  return (
    <>
      <Checkbox
        label="Allow multiple"
        checked={multiple}
        onChange={(e) => {
          setMultiple(e.target.checked);
          p.onChange({ maxSelect: e.target.checked ? many() : 1 });
        }}
      />
      {multiple && <Num p={p} k="maxSelect" label="Max select" />}
    </>
  );
}

function Domains({ p }: { p: OptionsProps }) {
  const only = (p.field.onlyDomains as string[] | undefined) ?? [];
  const except = (p.field.exceptDomains as string[] | undefined) ?? [];
  return (
    <>
      <List
        p={p}
        k="onlyDomains"
        label="Only domains"
        hint="Comma separated."
        disabled={except.length > 0}
      />
      <List
        p={p}
        k="exceptDomains"
        label="Except domains"
        hint="Comma separated."
        disabled={only.length > 0}
      />
    </>
  );
}

function RelationTarget({ p }: { p: OptionsProps }) {
  const collections = useCollections();
  return (
    <Select
      label="Collection"
      value={String(p.field.collectionId ?? "")}
      disabled={!!p.field.id}
      error={useError(p, "collectionId")}
      onChange={(e) => p.onChange({ collectionId: e.target.value })}
    >
      <option value="" disabled>
        Choose a collection
      </option>
      {(collections.data ?? [])
        .filter((c) => c.type !== "view")
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </Select>
  );
}

function MimeTypes({ p }: { p: OptionsProps }) {
  const current = (p.field.mimeTypes as string[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-1">
      <List p={p} k="mimeTypes" label="MIME types" hint="Comma separated." />
      <div className="flex flex-wrap gap-1">
        {Object.entries(MIME_PRESETS).map(([name, types]) => (
          <Button
            key={name}
            variant="ghost"
            onClick={() =>
              p.onChange({
                mimeTypes: [
                  ...current,
                  ...types.filter((t) => !current.includes(t)),
                ],
              })
            }
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function TypeOptions({ p }: { p: OptionsProps }) {
  switch (p.field.type) {
    case "text":
      return (
        <>
          <Num p={p} k="min" label="Min length" />
          <Num p={p} k="max" label="Max length" />
          <Text p={p} k="pattern" label="Pattern" />
          <Text p={p} k="autogeneratePattern" label="Autogenerate pattern" />
          {!!p.field.primaryKey && (
            <Bool p={p} k="primaryKey" label="Primary key" disabled />
          )}
        </>
      );
    case "number":
      return (
        <>
          <Num p={p} k="min" label="Min" nullable />
          <Num p={p} k="max" label="Max" nullable />
          <Bool p={p} k="onlyInt" label="Integers only" />
        </>
      );
    case "email":
    case "url":
      return <Domains p={p} />;
    case "date":
      return (
        <>
          <Text
            p={p}
            k="min"
            label="Min date"
            hint="YYYY-MM-DD HH:mm:ss.SSSZ (UTC)"
          />
          <Text
            p={p}
            k="max"
            label="Max date"
            hint="YYYY-MM-DD HH:mm:ss.SSSZ (UTC)"
          />
        </>
      );
    case "autodate":
      return (
        <>
          <Bool p={p} k="onCreate" label="On create" />
          <Bool p={p} k="onUpdate" label="On update" />
        </>
      );
    case "select":
      return (
        <>
          <List p={p} k="values" label="Values" hint="One per line." lines />
          <Multiple
            p={p}
            many={() =>
              Math.max(2, ((p.field.values as string[]) ?? []).length)
            }
          />
        </>
      );
    case "json":
      return <Num p={p} k="maxSize" label="Max size (bytes)" />;
    case "editor":
      return (
        <>
          <Num p={p} k="maxSize" label="Max size (bytes)" />
          <Bool p={p} k="convertURLs" label="Convert URLs" />
        </>
      );
    case "relation":
      return (
        <>
          <RelationTarget p={p} />
          <Multiple p={p} many={() => 999} />
          <Num p={p} k="minSelect" label="Min select" />
          <Bool p={p} k="cascadeDelete" label="Cascade delete" />
        </>
      );
    case "file":
      return (
        <>
          <Multiple p={p} many={() => 99} />
          <Num p={p} k="maxSize" label="Max size (bytes)" />
          <MimeTypes p={p} />
          <List
            p={p}
            k="thumbs"
            label="Thumb sizes"
            hint="WxH, WxHt, WxHb, WxHf, 0xH, Wx0"
          />
          <Bool p={p} k="protected" label="Protected" />
        </>
      );
    case "password":
      return (
        <>
          <Num p={p} k="min" label="Min length" />
          <Num p={p} k="max" label="Max length" />
          <Text p={p} k="pattern" label="Pattern" />
          <Num p={p} k="cost" label="Bcrypt cost" />
        </>
      );
    default:
      return null;
  }
}

export function FieldOptions(p: OptionsProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TypeOptions p={p} />
      {p.field.type !== "autodate" && <Text p={p} k="help" label="Help text" />}
    </div>
  );
}
