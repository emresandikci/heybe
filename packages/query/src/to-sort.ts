import type { OrderBy } from "./types.js";

export function toSort<T = Record<string, unknown>>(
  orderBy: OrderBy<NoInfer<T>> | undefined,
): string {
  if (!orderBy) return "";
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  return entries
    .flatMap((entry) => Object.entries(entry))
    .map(([name, direction]) => (direction === "desc" ? `-${name}` : name))
    .join(",");
}
