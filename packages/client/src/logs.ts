import {
  toAst,
  toFilter,
  toSort,
  type ListResult,
  type OrderBy,
  type Where,
} from "@heybejs/query";
import type { HeybeClient } from "./client.js";
import { joinFilter, joinSort, type RawListArgs } from "./raw.js";
import type { RequestOptions } from "./send.js";

export interface LogModel {
  id: string;
  created: string;
  level: number;
  message: string;
  data: Record<string, unknown>;
}

export type LogFields = LogModel & { [K: `data.${string}`]: unknown };

export interface LogsService {
  findMany(
    args?: {
      where?: Where<LogFields>;
      orderBy?: OrderBy<LogFields>;
      page?: number;
      perPage?: number;
      count?: boolean;
    } & RawListArgs,
    opts?: RequestOptions,
  ): Promise<ListResult<LogModel>>;
  findOne(id: string, opts?: RequestOptions): Promise<LogModel>;
  stats(
    args?: { where?: Where<LogFields>; filter?: string },
    opts?: RequestOptions,
  ): Promise<{ total: number; date: string }[]>;
  truncate(opts?: RequestOptions): Promise<void>;
}

const filterOf = (args?: { where?: Where<LogFields>; filter?: string }) =>
  joinFilter(args?.where ? toFilter(toAst(args.where)) : "", args?.filter) ||
  undefined;

export function createLogs(client: Pick<HeybeClient, "send">): LogsService {
  return {
    findMany(args, opts) {
      return client.send("/api/logs", {
        ...opts,
        query: {
          page: args?.page,
          perPage: args?.perPage,
          skipTotal: args?.count === false ? 1 : undefined,
          filter: filterOf(args),
          sort: joinSort(toSort(args?.orderBy), args?.sort) || undefined,
        },
      });
    },
    findOne: (id, opts) =>
      client.send(`/api/logs/${encodeURIComponent(id)}`, opts),
    stats: (args, opts) =>
      client.send("/api/logs/stats", {
        ...opts,
        query: { filter: filterOf(args) },
      }),
    truncate: (opts) => client.send("/api/logs", { ...opts, method: "DELETE" }),
  };
}
