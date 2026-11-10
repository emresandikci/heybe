export interface RawListArgs {
  filter?: string;
  sort?: string;
}

export function joinFilter(where: string, raw?: string): string {
  if (!where || !raw) return where || raw || "";
  return `(${where}) && (${raw})`;
}

export function joinSort(orderBy: string, raw?: string): string {
  return [orderBy, raw].filter(Boolean).join(",");
}
