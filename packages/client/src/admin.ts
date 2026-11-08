import {
  toAst,
  toFilter,
  toSort,
  type ListResult,
  type OrderBy,
  type Where,
} from "@heybe/query";
import type { HeybeClient } from "./client.js";
import type { RequestOptions } from "./send.js";

export type CollectionModel = {
  id: string;
  name: string;
  type: "base" | "auth" | "view";
  system: boolean;
  fields: Record<string, unknown>[];
  indexes: string[];
} & Record<string, unknown>;

export interface CollectionsService {
  findMany(
    args?: {
      where?: Where<Record<string, unknown>>;
      orderBy?: OrderBy<Record<string, unknown>>;
      page?: number;
      perPage?: number;
      count?: boolean;
    },
    opts?: RequestOptions,
  ): Promise<ListResult<CollectionModel>>;
  findOne(idOrName: string, opts?: RequestOptions): Promise<CollectionModel>;
  create(
    data: Partial<CollectionModel>,
    opts?: RequestOptions,
  ): Promise<CollectionModel>;
  update(
    idOrName: string,
    data: Partial<CollectionModel>,
    opts?: RequestOptions,
  ): Promise<CollectionModel>;
  delete(idOrName: string, opts?: RequestOptions): Promise<void>;
  truncate(idOrName: string, opts?: RequestOptions): Promise<void>;
  import(
    collections: Partial<CollectionModel>[],
    deleteMissing?: boolean,
    opts?: RequestOptions,
  ): Promise<void>;
  scaffolds(opts?: RequestOptions): Promise<Record<string, CollectionModel>>;
}

export interface SettingsService {
  get(opts?: RequestOptions): Promise<Record<string, unknown>>;
  update(
    data: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<Record<string, unknown>>;
  testEmail(
    collection: string,
    email: string,
    template: string,
    opts?: RequestOptions,
  ): Promise<void>;
  generateAppleClientSecret(
    clientId: string,
    teamId: string,
    keyId: string,
    privateKey: string,
    duration: number,
    opts?: RequestOptions,
  ): Promise<{ secret: string }>;
}

export interface CronsService {
  list(opts?: RequestOptions): Promise<{ id: string; expression: string }[]>;
  run(id: string, opts?: RequestOptions): Promise<void>;
}

export interface HealthService {
  check(opts?: RequestOptions): Promise<{
    code: number;
    message: string;
    data: Record<string, unknown>;
  }>;
}

type Sender = Pick<HeybeClient, "send">;

const enc = encodeURIComponent;

export function createCollections(client: Sender): CollectionsService {
  const one = (idOrName: string) => `/api/collections/${enc(idOrName)}`;
  return {
    findMany(args, opts) {
      const filter = args?.where ? toFilter(toAst(args.where)) : "";
      const sort = toSort(args?.orderBy);
      return client.send("/api/collections", {
        ...opts,
        query: {
          page: args?.page,
          perPage: args?.perPage,
          skipTotal: args?.count === false ? 1 : undefined,
          filter: filter || undefined,
          sort: sort || undefined,
        },
      });
    },
    findOne: (idOrName, opts) => client.send(one(idOrName), opts),
    create: (data, opts) =>
      client.send("/api/collections", { ...opts, method: "POST", body: data }),
    update: (idOrName, data, opts) =>
      client.send(one(idOrName), { ...opts, method: "PATCH", body: data }),
    delete: (idOrName, opts) =>
      client.send(one(idOrName), { ...opts, method: "DELETE" }),
    truncate: (idOrName, opts) =>
      client.send(`${one(idOrName)}/truncate`, { ...opts, method: "DELETE" }),
    import: (collections, deleteMissing = false, opts) =>
      client.send("/api/collections/import", {
        ...opts,
        method: "PUT",
        body: { collections, deleteMissing },
      }),
    scaffolds: (opts) => client.send("/api/collections/meta/scaffolds", opts),
  };
}

export function createSettings(client: Sender): SettingsService {
  return {
    get: (opts) => client.send("/api/settings", opts),
    update: (data, opts) =>
      client.send("/api/settings", { ...opts, method: "PATCH", body: data }),
    testEmail: (collection, email, template, opts) =>
      client.send("/api/settings/test/email", {
        ...opts,
        method: "POST",
        body: { email, template, collection },
      }),
    generateAppleClientSecret: (
      clientId,
      teamId,
      keyId,
      privateKey,
      duration,
      opts,
    ) =>
      client.send("/api/settings/apple/generate-client-secret", {
        ...opts,
        method: "POST",
        body: { clientId, teamId, keyId, privateKey, duration },
      }),
  };
}

export function createCrons(client: Sender): CronsService {
  return {
    list: (opts) => client.send("/api/crons", opts),
    run: (id, opts) =>
      client.send(`/api/crons/${enc(id)}`, { ...opts, method: "POST" }),
  };
}

export function createHealth(client: Sender): HealthService {
  return { check: (opts) => client.send("/api/health", opts) };
}
