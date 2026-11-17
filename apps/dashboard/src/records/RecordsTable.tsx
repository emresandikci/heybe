import { Table, Td, Th } from "@heybe/ui";
import { CellValue, type CellField } from "./cell";

type Row = Record<string, unknown> & { id: string };

function sortState(sort: string, name: string) {
  if (sort === name) return "asc";
  if (sort === `-${name}`) return "desc";
  return "none";
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
}) {
  const next = (name: string) => {
    const state = sortState(sort, name);
    return state === "none" ? name : state === "asc" ? `-${name}` : "";
  };
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const label = (row: Row) => String(row.title ?? row.name ?? row.id);
  return (
    <Table caption={caption}>
      <thead>
        <tr>
          <th scope="col" className="w-8 px-3 py-2">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
            />
          </th>
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
            className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
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
            <Td>
              <input
                type="checkbox"
                aria-label={`Select ${label(row)}`}
                checked={selected.has(row.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onSelect(row.id)}
              />
            </Td>
            {fields.map((f) => (
              <Td key={f.name}>
                <CellValue field={f} value={row[f.name]} record={row} />
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
