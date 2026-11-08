import {
  toAst,
  toExpand,
  toFilter,
  toSort,
  type Expand,
  type ExpandOf,
  type FindManyArgs,
  type ListResult,
  type NoExtraExpand,
  type WithExpand,
} from "@heybe/query";
import type { AuthRecord } from "./auth-store.js";
import type { HeybeClient } from "./client.js";
import { HeybeError } from "./error.js";
import type { RequestOptions } from "./send.js";

export type BaseFields = {
  id: string;
  collectionId: string;
  collectionName: string;
};

export type Rec<T, E = undefined> = WithExpand<T, E> & BaseFields;

type FileInput = File | Blob | (File | Blob)[];

export type WriteData<T> = { [K in keyof T]?: T[K] | FileInput } & {
  [modifier: `${string}+` | `+${string}` | `${string}-`]:
    string | string[] | FileInput;
};

type NoExtraKeys<A, Allowed> = {
  [K in Exclude<keyof A, keyof Allowed>]: never;
};

type FirstArgs<T> = Omit<FindManyArgs<T>, "page" | "perPage" | "count">;

export interface RecordsClient<T> {
  readonly collection: string;
  findMany<A extends FindManyArgs<T> = {}>(
    args?: A &
      NoExtraKeys<A, FindManyArgs<T>> & {
        expand?: NoExtraExpand<T, ExpandOf<A>>;
      },
    opts?: RequestOptions,
  ): Promise<ListResult<Rec<T, ExpandOf<A>>>>;
  findOne<E extends Expand<T> | undefined = undefined>(
    id: string,
    args?: { expand?: E & NoExtraExpand<T, E> },
    opts?: RequestOptions,
  ): Promise<Rec<T, E>>;
  findFirst<A extends FirstArgs<T> = {}>(
    args?: A &
      NoExtraKeys<A, FindManyArgs<T>> & {
        expand?: NoExtraExpand<T, ExpandOf<A>>;
      },
    opts?: RequestOptions,
  ): Promise<Rec<T, ExpandOf<A>>>;
  create<E extends Expand<T> | undefined = undefined>(
    data: WriteData<T> | FormData,
    args?: { expand?: E & NoExtraExpand<T, E> },
    opts?: RequestOptions,
  ): Promise<Rec<T, E>>;
  update<E extends Expand<T> | undefined = undefined>(
    id: string,
    data: WriteData<T> | FormData,
    args?: { expand?: E & NoExtraExpand<T, E> },
    opts?: RequestOptions,
  ): Promise<Rec<T, E>>;
  delete(id: string, opts?: RequestOptions): Promise<void>;
}

type Args = FindManyArgs<unknown>;

function compact(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== "" && value != null),
  );
}

function listQuery(args: Args | undefined, single: boolean) {
  return compact({
    page: single ? 1 : args?.page,
    perPage: single ? 1 : args?.perPage,
    skipTotal: single || args?.count === false ? 1 : undefined,
    filter: args?.where ? toFilter(toAst(args.where)) : "",
    sort: toSort(args?.orderBy),
    expand: toExpand(args?.expand),
  });
}

const notFound = (message: string, data = {}) =>
  new HeybeError({ status: 404, response: { code: 404, message, data } });

export function createRecords<T>(
  client: Pick<HeybeClient, "send" | "authStore">,
  collection: string,
): RecordsClient<T> {
  const basePath = `/api/collections/${encodeURIComponent(collection)}/records`;
  const recordPath = (id: string) => `${basePath}/${encodeURIComponent(id)}`;
  const expandQuery = (args?: { expand?: unknown }) =>
    compact({ expand: toExpand(args?.expand as Expand<unknown>) });

  function isAuthRecord(id: string) {
    const record = client.authStore.record;
    return (
      record?.id === id &&
      (record.collectionId === collection ||
        record.collectionName === collection)
    );
  }

  return {
    collection,
    findMany(args, opts) {
      return client.send(basePath, {
        ...opts,
        query: listQuery(args as Args | undefined, false),
      });
    },
    async findOne(id, args, opts) {
      if (!id) throw notFound("Missing required record id.");
      return client.send(recordPath(id), { ...opts, query: expandQuery(args) });
    },
    async findFirst(args, opts) {
      const query = listQuery(args as Args | undefined, true);
      const result = await client.send<ListResult<never>>(basePath, {
        ...opts,
        requestKey:
          opts?.requestKey === undefined
            ? `one_by_filter_${basePath}_${query.filter ?? ""}`
            : opts.requestKey,
        query,
      });
      if (!result?.items?.length)
        throw notFound("The requested resource wasn't found.");
      return result.items[0];
    },
    create(data, args, opts) {
      return client.send(basePath, {
        ...opts,
        method: "POST",
        body: data,
        query: expandQuery(args),
      });
    },
    async update(id, data, args, opts) {
      const item = await client.send<AuthRecord>(recordPath(id), {
        ...opts,
        method: "PATCH",
        body: data,
        query: expandQuery(args),
      });
      if (isAuthRecord(item.id)) {
        const old = client.authStore.record!;
        const merged = { ...old, ...item };
        if (old.expand || item.expand)
          merged.expand = {
            ...(old.expand as object),
            ...(item.expand as object),
          };
        client.authStore.save(client.authStore.token, merged);
      }
      return item as never;
    },
    async delete(id, opts) {
      await client.send(recordPath(id), { ...opts, method: "DELETE" });
      if (isAuthRecord(id)) client.authStore.clear();
    },
  };
}
