import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useClient } from "../app/context";
import { keys, useCollections } from "../app/queries";

export type CellField = {
  name: string;
  type: string;
  [option: string]: unknown;
};

const LIMIT = 100;
const IMAGE = /\.(jpe?g|png|gif|webp)$/i;

const cut = (text: string) => text.slice(0, LIMIT);
const list = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value ? [value] : [];

function htmlText(html: string): string {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  );
}

function DateCell({ value }: { value: string }) {
  const local = new Date(value.replace(" ", "T"));
  const title = Number.isNaN(local.getTime())
    ? undefined
    : local.toLocaleString();
  return <span title={title}>{value}</span>;
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
  const { data: token } = useQuery({
    queryKey: keys.fileToken,
    queryFn: ({ signal }) => client.files.token({ signal }),
    staleTime: 120000,
    enabled: !!field.protected,
  });
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
  const presentable = (target?.fields ?? [])
    .filter((f) => f.presentable)
    .map((f) => f.name as string);
  const expand = (record.expand as Record<string, unknown> | undefined)?.[
    field.name
  ];
  const expanded = new Map(
    list(expand).map((r) => [
      (r as { id: string }).id,
      r as Record<string, unknown>,
    ]),
  );
  const labels = list(value).map((id) => {
    const text = presentable
      .map((name) => expanded.get(id as string)?.[name])
      .filter((v) => v !== undefined && v !== "")
      .join(" ");
    return text || String(id);
  });
  return <>{cut(labels.join(", "))}</>;
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
