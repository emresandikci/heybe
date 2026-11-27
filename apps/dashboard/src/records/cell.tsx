import type { CollectionModel } from "@heybejs/client";
import { useQuery } from "@tanstack/react-query";
import { Tooltip } from "@heybejs/ui";
import type { ReactNode } from "react";
import { useClient } from "../app/context";
import { keys, useCollections } from "../app/queries";
import { formatDate } from "../app/format";

export type CellField = {
  name: string;
  type: string;
  [option: string]: unknown;
};

const LIMIT = 100;
export const IMAGE = /\.(jpe?g|png|gif|webp)$/i;

const cut = (text: string) => text.slice(0, LIMIT);
export const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value ? [value] : [];

function htmlText(html: string): string {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  body.querySelectorAll("script, style").forEach((el) => el.remove());
  return body.textContent ?? "";
}

function DateCell({ value }: { value: string }) {
  const text = formatDate(value);
  if (text === value) return <span>{value}</span>;
  return (
    <Tooltip content={value}>
      <span tabIndex={0}>{text}</span>
    </Tooltip>
  );
}

export function useFileToken(field: CellField) {
  const client = useClient();
  return useQuery({
    queryKey: keys.fileToken,
    queryFn: ({ signal }) => client.files.token({ signal }),
    staleTime: 120000,
    enabled: !!field.protected,
  }).data;
}

function FileCell({
  field,
  names,
  record,
}: {
  field: CellField;
  names: string[];
  record: Record<string, unknown>;
}) {
  const client = useClient();
  const token = useFileToken(field);
  if (field.protected && token === undefined) return null;
  return (
    <span className="flex gap-1">
      {names.map((name) =>
        IMAGE.test(name) ? (
          <img
            key={name}
            alt={name}
            width={32}
            height={32}
            src={client.files.url(record, name, { thumb: "100x100", token })}
          />
        ) : (
          <span key={name}>{name}</span>
        ),
      )}
    </span>
  );
}

export function presentableLabel(
  target: CollectionModel | undefined,
  record: Record<string, unknown> | undefined,
  id: string,
): string {
  const text = (target?.fields ?? [])
    .filter((f) => f.presentable)
    .map((f) => record?.[f.name as string])
    .filter((v) => v !== undefined && v !== null && v !== "")
    .join(" ");
  return text || id;
}

export function expandedRecords(
  record: Record<string, unknown>,
  name: string,
): Map<string, Record<string, unknown>> {
  const expand = (record.expand as Record<string, unknown> | undefined)?.[name];
  return new Map(
    list(expand).map((r) => [
      (r as { id: string }).id,
      r as Record<string, unknown>,
    ]),
  );
}

function RelationCell({
  field,
  value,
  record,
}: {
  field: CellField;
  value: unknown;
  record: Record<string, unknown>;
}) {
  const collections = useCollections();
  const target = collections.data?.find((c) => c.id === field.collectionId);
  const expanded = expandedRecords(record, field.name);
  const labels = list(value).map((id) =>
    presentableLabel(target, expanded.get(id as string), String(id)),
  );
  const text = cut(labels.join(", "));
  return (
    <span className="block truncate" title={text}>
      {text}
    </span>
  );
}

export function CellValue({
  field,
  value,
  record,
}: {
  field: CellField;
  value: unknown;
  record: Record<string, unknown>;
}): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  switch (field.type) {
    case "bool":
      return value ? "Yes" : "No";
    case "date":
    case "autodate":
      return <DateCell value={String(value)} />;
    case "editor":
      return cut(htmlText(String(value)));
    case "json":
      return cut(JSON.stringify(value) ?? "");
    case "select":
      return cut(list(value).join(", "));
    case "geoPoint": {
      const { lon, lat } = value as { lon: number; lat: number };
      return `${lon}, ${lat}`;
    }
    case "password":
      return "******";
    case "relation":
      return <RelationCell field={field} value={value} record={record} />;
    case "file":
      return (
        <FileCell
          field={field}
          names={list(value).map(String)}
          record={record}
        />
      );
    default:
      return cut(String(value));
  }
}
