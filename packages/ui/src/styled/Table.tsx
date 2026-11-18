import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

export type SortDirection = "asc" | "desc";

export function Table({
  caption,
  stickyHeader,
  children,
}: {
  caption?: string;
  stickyHeader?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`overflow-auto${stickyHeader ? " max-h-[calc(100dvh-12rem)]" : ""}`}
    >
      <table
        data-sticky-header={stickyHeader || undefined}
        className={`w-full border-collapse text-left text-sm${stickyHeader ? " [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-surface" : ""}`}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

const sortIcon = { asc: ArrowUp, desc: ArrowDown };

export function Th({
  children,
  sort,
  onSort,
  align,
}: {
  children: ReactNode;
  align?: "left" | "right";
  sort?: SortDirection | null;
  onSort?: () => void;
}) {
  const ariaSort =
    sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none";
  const Icon = sort ? sortIcon[sort] : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={onSort ? ariaSort : undefined}
      className={`border-b border-line px-3 py-2 text-xs font-medium text-muted${align === "right" ? " text-right" : ""}`}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="inline-flex items-center gap-1 rounded font-medium hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
        >
          {children}
          <Icon
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className={sort ? "text-text" : "text-faint"}
          />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({
  children,
  wrap,
  align,
}: {
  children?: ReactNode;
  wrap?: boolean;
  align?: "left" | "right";
}) {
  const truncate = !wrap && typeof children === "string";
  return (
    <td
      title={truncate ? children : undefined}
      className={`border-b border-line px-3 py-2 text-text${align === "right" ? " text-right" : ""}${wrap ? "" : " max-w-xs whitespace-nowrap"}${truncate ? " truncate" : ""}`}
    >
      {children}
    </td>
  );
}
