import type { ListResult } from "@heybe/query";
import type { App } from "../app";
import {
  type PreparedWrite,
  type QueryOpts,
  type RecordService,
  RecordServiceImpl,
} from "./service";

export type { PreparedWrite, QueryOpts };

export interface InternalRecords<
  T = Record<string, unknown>,
> extends RecordService<T> {
  findRaw(id: string): Record<string, unknown>;
  query(opts: QueryOpts): ListResult<T>;
  truncate(): Promise<void>;
  // Writes in parts, for batches: `prepare` before the transaction, the `*Prepared` writes
  // inside it, `settle` after it.
  prepare(data: Partial<T>, id?: string): Promise<PreparedWrite>;
  createPrepared(p: PreparedWrite, data: Partial<T>): Promise<T>;
  updatePrepared(
    p: PreparedWrite,
    id: string,
    data: Partial<T>,
    opts?: { tokenKey?: string },
  ): Promise<T>;
  deletePrepared(p: PreparedWrite, id: string): Promise<void>;
  settle(p: PreparedWrite): Promise<void>;
}

export function internalRecords(app: App, name: string): InternalRecords {
  return new RecordServiceImpl(app, name);
}
