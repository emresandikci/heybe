import {
  toExpand,
  type CollectionName,
  type Collections,
  type Expand,
} from "@heybejs/query";
import type { HeybeClient } from "./client.js";
import type { WriteData } from "./records.js";
import { serializeQuery, type RequestOptions } from "./send.js";

export interface BatchResult {
  status: number;
  body: unknown;
}

export interface BatchRecords<T> {
  create(data: WriteData<T>, args?: { expand?: Expand<T> }): void;
  update(id: string, data: WriteData<T>, args?: { expand?: Expand<T> }): void;
  upsert(data: WriteData<T>, args?: { expand?: Expand<T> }): void;
  delete(id: string): void;
}

export interface Batch {
  records<N extends CollectionName>(name: N): BatchRecords<Collections[N]>;
  records(name: string): BatchRecords<Record<string, unknown>>;
  send(opts?: RequestOptions): Promise<BatchResult[]>;
}

interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const isFile = (value: unknown) => value instanceof Blob;

function split(data: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const files: Record<string, Blob[]> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) {
      if (isFile(value)) files[key] = [value as Blob];
      else body[key] = value;
      continue;
    }
    const blobs = value.filter(isFile) as Blob[];
    if (blobs.length === 0) {
      body[key] = value;
      continue;
    }
    const names = value.filter((item) => !isFile(item));
    if (names.length === 0) {
      files[key] = blobs;
      continue;
    }
    body[key] = names;
    files[key.endsWith("+") ? key : `${key}+`] = blobs;
  }
  return { body, files };
}

export function createBatch(client: Pick<HeybeClient, "send">): Batch {
  const requests: Request[] = [];
  const files: [number, string, Blob][] = [];

  function add(
    method: string,
    path: string,
    data: Record<string, unknown> = {},
    expand?: unknown,
  ) {
    const parts = split(data);
    const query = serializeQuery({
      expand: toExpand(expand as Expand<never>) || undefined,
    });
    requests.push({
      method,
      url: query ? `${path}?${query}` : path,
      headers: {},
      body: parts.body,
    });
    for (const [key, blobs] of Object.entries(parts.files))
      for (const blob of blobs) files.push([requests.length - 1, key, blob]);
  }

  return {
    records: (name: string) => {
      const base = `/api/collections/${encodeURIComponent(name)}/records`;
      const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
      return {
        create: (data, args) => add("POST", base, data, args?.expand),
        update: (id, data, args) => add("PATCH", one(id), data, args?.expand),
        upsert: (data, args) => add("PUT", base, data, args?.expand),
        delete: (id) => add("DELETE", one(id)),
      } as BatchRecords<never>;
    },
    async send(opts) {
      const form = new FormData();
      form.append("@jsonPayload", JSON.stringify({ requests }));
      for (const [index, key, blob] of files)
        form.append(`requests.${index}.${key}`, blob);
      return client.send<BatchResult[]>("/api/batch", {
        ...opts,
        method: "POST",
        body: form,
      });
    },
  } as Batch;
}
