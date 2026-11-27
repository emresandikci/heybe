import { useLayoutEffect, useRef, useState } from "react";
import { Checkbox, Table, Td, Th } from "@heybejs/ui";
import { CellValue, type CellField } from "./cell";

const STICKY_FIRST =
  "[&_tr>:nth-child(1)]:sticky [&_tr>:nth-child(1)]:left-0 [&_tr>:nth-child(1)]:z-[5] [&_thead_tr>:nth-child(1)]:z-20";
const STICKY_SECOND =
  "[&_tr>:nth-child(2)]:sticky [&_tr>:nth-child(2)]:left-10 [&_tr>:nth-child(2)]:z-[5] [&_thead_tr>:nth-child(2)]:z-20";

// Tints are inset shadows over an opaque cell background so sticky cells hide the columns scrolled under them.
const ROW =
  "cursor-pointer bg-surface [&>td]:bg-surface [&:not([data-selected]):hover>td]:shadow-[inset_0_0_0_100vmax_var(--hb-hover)] data-[selected]:[&>td]:shadow-[inset_0_0_0_100vmax_var(--hb-accent-soft)]";

type Row = Record<string, unknown> & { id: string };

function sortState(sort: string, name: string) {
  if (sort === name) return "asc";
  if (sort === `-${name}`) return "desc";
  return null;
}

export function RecordsTable({
  caption,
  fields,
  rows,
  sort,
  selected,
  onSort,
  onSelect,
  onSelectAll,
  onOpen,
  selectable = true,
}: {
  caption: string;
  fields: CellField[];
  rows: Row[];
  sort: string;
  selected: Set<string>;
  onSort: (sort: string) => void;
  onSelect: (id: string) => void;
  onSelectAll: (all: boolean) => void;
  onOpen: (id: string) => void;
  selectable?: boolean;
}) {
  const [edges, setEdges] = useState({ left: false, right: false });
  const wrapper = useRef<HTMLDivElement>(null);
  const measure = (el: Element) => {
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  };
  useLayoutEffect(() => {
    const scroller = wrapper.current?.querySelector(".overflow-auto");
    if (!scroller) return;
    measure(scroller);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure(scroller));
    observer.observe(scroller);
    if (scroller.firstElementChild)
      observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [fields.length, rows.length]);
  const hasId = fields[0]?.name === "id";
  const sticky = [
    selectable ? STICKY_FIRST : "",
    hasId ? (selectable ? STICKY_SECOND : STICKY_FIRST) : "",
  ].join(" ");
  const next = (name: string) => {
    const state = sortState(sort, name);
    return state === null ? name : state === "asc" ? `-${name}` : "";
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const label = (row: Row) => String(row.title ?? row.name ?? row.id);
  return (
    <div
      ref={wrapper}
      onScrollCapture={(e) => measure(e.target as Element)}
      className={`relative ${sticky}`}
    >
      <Edge side="left" show={edges.left} />
      <Edge side="right" show={edges.right} />
      <Table caption={caption} stickyHeader>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="w-10 border-b border-line px-3 py-2">
                <Checkbox
                  hideLabel
                  label="Select all"
                  checked={allSelected}
                  onChange={(e) => onSelectAll(e.target.checked)}
                />
              </th>
            )}
            {fields.map((f) => (
              <Th
                key={f.name}
                sort={sortState(sort, f.name)}
                onSort={() => onSort(next(f.name))}
              >
                {f.name}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              tabIndex={0}
              data-selected={selected.has(row.id) || undefined}
              className={ROW}
              onClick={() => onOpen(row.id)}
              onKeyDown={(e) => {
                if (
                  (e.key === "Enter" || e.key === " ") &&
                  e.target === e.currentTarget
                ) {
                  e.preventDefault();
                  onOpen(row.id);
                }
              }}
            >
              {selectable && (
                <Td>
                  <Checkbox
                    hideLabel
                    label={`Select ${label(row)}`}
                    checked={selected.has(row.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => onSelect(row.id)}
                  />
                </Td>
              )}
              {fields.map((f) => (
                <Td key={f.name}>
                  {/* Called directly so plain text reaches Td's truncation and title. */}
                  {CellValue({ field: f, value: row[f.name], record: row })}
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function Edge({ side, show }: { side: "left" | "right"; show: boolean }) {
  return (
    <div
      aria-hidden
      data-edge={side}
      className={`pointer-events-none absolute inset-y-0 z-30 w-3 transition-opacity motion-reduce:transition-none ${side === "left" ? "left-0 bg-gradient-to-r" : "right-0 bg-gradient-to-l"} from-black/15 to-transparent ${show ? "opacity-100" : "opacity-0"}`}
    />
  );
}
