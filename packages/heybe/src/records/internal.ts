import type { ListResult } from "@heybe/query";
import type { App } from "../app";
import type { RecordModel } from "./model";
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
  // The same writes on a record, which request hooks see before it is saved.
  draft(
    p: PreparedWrite,
    data: Partial<T>,
    original?: Record<string, unknown>,
  ): RecordModel;
  savePrepared(
    p: PreparedWrite,
    record: RecordModel,
    opts?: { tokenKey?: string },
  ): Promise<T>;
  deleteRecord(record: RecordModel): Promise<void>;
  // the hooked delete of each matching record, each its own write unless called inside one
  deleteWhere(where: string, params: unknown[]): Promise<void>;
  // runs `write` and settles `p` once the outermost write ended
  commit<R>(p: PreparedWrite, write: () => Promise<R>): Promise<R>;
  settle(p: PreparedWrite): Promise<void>;
}

export function internalRecords(app: App, name: string): InternalRecords {
  return new RecordServiceImpl(app, name);
}
