import { useFieldError } from "../../app/errors";
import { Checkbox } from "../../ui/Checkbox";
import { NumberField } from "../../ui/NumberField";
import { TextField } from "../../ui/TextField";
import type { CellField } from "../cell";
import { isMulti, type FileValue } from "../record-form";
import { DateInput } from "./DateInput";
import { EditorInput } from "./EditorInput";
import { FileInput } from "./FileInput";
import { RelationInput } from "./RelationInput";
import { GeoPointInput, type GeoValue } from "./GeoPointInput";
import { JsonInput } from "./JsonInput";
import { SelectInput } from "./SelectInput";

const AUTH_LABELS: Record<string, string> = {
  email: "Email",
  emailVisibility: "Public email",
  verified: "Verified",
};

export function FieldInput({
  field,
  value,
  authCollection,
  record,
  disabled,
  localError,
  onChange,
}: {
  field: CellField;
  value: unknown;
  authCollection: boolean;
  record?: Record<string, unknown>;
  disabled: boolean;
  localError?: string;
  onChange: (value: unknown) => void;
}) {
  const error = useFieldError(field.name) ?? localError;
  const label = (authCollection && AUTH_LABELS[field.name]) || field.name;
  const text = value as string;
  switch (field.type) {
    case "text":
    case "email":
    case "url":
      return (
        <TextField
          label={label}
          type={field.type === "text" ? "text" : field.type}
          hint={
            field.name === "id" && field.primaryKey
              ? "Leave empty to generate"
              : undefined
          }
          value={text}
          error={error}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <NumberField
          label={label}
          step={field.onlyInt ? 1 : "any"}
          value={text}
          error={error}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "bool":
      return (
        <Checkbox
          label={label}
          checked={value as boolean}
          error={error}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "date":
      return (
        <DateInput
          name={label}
          value={text}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "autodate":
      return <TextField label={label} value={text} readOnly />;
    case "select":
      return (
        <SelectInput
          name={label}
          options={(field.values as string[]) ?? []}
          multiple={isMulti(field)}
          value={value as string | string[]}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "json":
      return (
        <JsonInput
          name={label}
          value={text}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "editor":
      return (
        <EditorInput
          name={label}
          value={text}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "geoPoint":
      return (
        <GeoPointInput
          name={label}
          value={value as GeoValue}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "file":
      return (
        <FileInput
          field={field}
          name={label}
          value={value as FileValue}
          record={record}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "relation":
      return (
        <RelationInput
          field={field}
          name={label}
          value={value as string | string[]}
          record={record}
          error={error}
          disabled={disabled}
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

export const hasInput = (field: CellField) => field.type !== "password";
