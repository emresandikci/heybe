import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";

export function Table({
  caption,
  children,
}: {
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  sort,
  onSort,
}: {
  children: ReactNode;
  sort?: SortDirection | "none";
  onSort?: () => void;
}) {
  const ariaSort =
    sort === "asc" ? "ascending" : sort === "desc" ? "descending" : undefined;
  return (
    <th
      scope="col"
      aria-sort={onSort ? (ariaSort ?? "none") : undefined}
      className="border-b border-slate-200 px-3 py-2 font-medium dark:border-slate-700"
    >
      {onSort ? (
        <button type="button" onClick={onSort}>
          {children}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children }: { children?: ReactNode }) {
  return (
    <td className="border-b border-slate-100 px-3 py-2 dark:border-slate-800">
      {children}
    </td>
  );
}
