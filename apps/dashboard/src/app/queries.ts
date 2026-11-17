import type { CollectionModel, ListResult } from "@heybe/client";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useClient } from "./context";

export const keys = {
  collections: ["collections"] as const,
  settings: ["settings"] as const,
  records: (c: string, q: object) => ["records", c, q] as unknown[],
  logs: (q: object) => ["logs", q] as unknown[],
  backups: ["backups"] as const,
  crons: ["crons"] as const,
  health: ["health"] as const,
  fileToken: ["fileToken"] as const,
};

export function useSqlSchema(): Record<string, string[]> {
  const { data } = useCollections();
  return Object.fromEntries(
    (data ?? []).map((c) => [c.name, c.fields.map((f) => String(f.name))]),
  );
}

export async function listAll<T>(
  page: (n: number) => Promise<ListResult<T>>,
): Promise<T[]> {
  const items: T[] = [];
  let n = 1;
  for (;;) {
    const result = await page(n);
    items.push(...result.items);
    if (result.page >= result.totalPages) return items;
    n = result.page + 1;
  }
}

export function useCollections(): UseQueryResult<CollectionModel[]> {
  const client = useClient();
  return useQuery({
    queryKey: keys.collections,
    queryFn: ({ signal }) =>
      listAll((page) =>
        client.collections.findMany(
          { perPage: 1000, page, orderBy: { name: "asc" } },
          { signal },
        ),
      ),
  });
}
