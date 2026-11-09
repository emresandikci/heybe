import type { HeybeClient } from "./client.js";
import type { RequestOptions } from "./send.js";

export interface SqlResult {
  execTime: number;
  affectedRows: number;
  columns: { name: string; type: string; nullable: boolean }[];
  rows: (string | null)[][];
}

export interface SqlService {
  run(query: string, opts?: RequestOptions): Promise<SqlResult>;
}

export function createSql(client: Pick<HeybeClient, "send">): SqlService {
  return {
    run: (query, opts) =>
      client.send("/api/sql", { ...opts, method: "POST", body: { query } }),
  };
}
