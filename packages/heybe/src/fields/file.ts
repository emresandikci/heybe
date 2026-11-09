import { sqlType } from "../collections/ddl";
import type { Field } from "../collections/model";
import { mimeExtension, sniffMime } from "../files/mime";
import { normalizeFilename } from "../files/name";
import { fileKey } from "../files/storage";
import {
  type FieldDef,
  fail,
  isMultiple,
  listFromDb,
  listToDb,
  required,
  uniqueStrings,
  unsupportedType,
} from "./shared";

const DEFAULT_MAX_SIZE = 5 << 20;

// A new file already written to storage under `name`.
export class UploadedFile {
  constructor(
    readonly name: string,
    readonly originalName: string,
    readonly size: number,
    readonly type: string,
  ) {}
}

type FileItem = string | File | UploadedFile;

const isUpload = (v: unknown): v is File | UploadedFile =>
  v instanceof File || v instanceof UploadedFile;

// Port of PB FileField.toSliceValue + uniqueFiles: names, pending Files and uploads, unique by name.
export function fileItems(value: unknown): FileItem[] {
  let items: FileItem[];
  if (isUpload(value)) items = [value];
  else if (Array.isArray(value))
    items = value.flatMap((v) => {
      const one = fileItems(v);
      return one.length === 1 ? one : [];
    });
  else items = uniqueStrings(value);

  const seen = new Set<unknown>();
  return items.filter((item) => {
    const key = item instanceof UploadedFile ? item.name : item;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const nameOf = (item: FileItem) =>
  typeof item === "string" ? item : item.name;

const maxFileSize = (field: Field) =>
  Number(field.maxSize) > 0 ? Number(field.maxSize) : DEFAULT_MAX_SIZE;

const maxFiles = (field: Field) =>
  Number(field.maxSelect) > 1 ? Number(field.maxSelect) : 1;

const baseMime = (mime: string) => mime.split(";")[0]!.trim().toLowerCase();

export const file: FieldDef = {
  sqlType: sqlType("file"),
  maxBodySize: (field) => maxFileSize(field) * maxFiles(field),
  normalize(value, field) {
    const items = fileItems(value);
    return isMultiple(field) ? items : (items[items.length - 1] ?? "");
  },
  validate(value, field, ctx) {
    const files = fileItems(value);
    // a File that skipped prepare would be stored under its client name
    if (files.some((f) => f instanceof File)) return unsupportedType();
    if (files.length === 0) return field.required === true ? required() : null;

    const existing = uniqueStrings(ctx.original?.[field.name]);
    const added = files.filter(
      (f): f is string => typeof f === "string" && !existing.includes(f),
    );
    if (added.length > 0) {
      return fail(
        "validation_invalid_file",
        "Invalid new files: {{.invalidFiles}}.",
        {
          invalidFiles: added.map((name) => name.slice(0, 250)),
        },
      );
    }

    const maxSelect = maxFiles(field);
    if (files.length > maxSelect)
      return fail(
        "validation_too_many_files",
        "The maximum allowed files is {{.maxSelect}}",
        { maxSelect },
      );

    const mimeTypes = Array.isArray(field.mimeTypes)
      ? field.mimeTypes.map(String)
      : [];
    for (const upload of files) {
      if (!(upload instanceof UploadedFile)) continue;
      const maxSize = maxFileSize(field);
      if (upload.size > maxSize)
        return fail(
          "validation_file_size_limit",
          "Failed to upload {{.file}} - the maximum allowed file size is {{.maxSize}} bytes.",
          { file: upload.originalName.slice(0, 300), maxSize },
        );
      if (
        mimeTypes.length > 0 &&
        !mimeTypes.some((t) => baseMime(t) === baseMime(upload.type))
      )
        return fail(
          "validation_invalid_mime_type",
          `${JSON.stringify(upload.name)} mime type must be one of: ${mimeTypes.join(", ")}.`,
        );
    }
    return null;
  },
  async prepare(value, _field, ctx) {
    // nested arrays too, since normalize flattens one-item arrays
    const upload = async (item: unknown): Promise<unknown> => {
      if (Array.isArray(item)) {
        const out: unknown[] = [];
        for (const v of item) out.push(await upload(v));
        return out;
      }
      if (!(item instanceof File)) return item;
      const type = await sniffMime(item);
      const name = normalizeFilename(item.name ?? "", mimeExtension(type));
      const key = fileKey(ctx.collection.id, ctx.recordId, name);
      await ctx.files.write(key, item, type);
      ctx.written.push(key);
      return new UploadedFile(name, item.name ?? "", item.size, type);
    };
    return upload(value);
  },
  toDb(value) {
    if (Array.isArray(value)) return listToDb(fileItems(value).map(nameOf));
    return isUpload(value) ? value.name : value;
  },
  fromDb: listFromDb,
};
