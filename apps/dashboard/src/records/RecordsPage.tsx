import type { CollectionModel } from "@heybe/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { keys } from "../app/queries";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/Confirm";
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../ui/Toasts";
import { ColumnsMenu } from "./ColumnsMenu";
import { Pagination } from "./Pagination";
import { RecordEditor } from "./RecordEditor";
import { RecordsTable } from "./RecordsTable";
import { SearchBar } from "./SearchBar";
import type { CellField } from "./cell";
import { normalizeSearchFilter } from "./search-filter";
import { expandOf } from "./record-form";
import { readList, writeList } from "./storage";

export type RecordsSearch = {
  filter?: string;
  sort?: string;
  page?: number;
  record?: string;
};

export function validateRecordsSearch(
  search: Record<string, unknown>,
): RecordsSearch {
  const out: RecordsSearch = {};
  if (typeof search.filter === "string" && search.filter)
    out.filter = search.filter;
  if (typeof search.sort === "string" && search.sort) out.sort = search.sort;
  if (typeof search.record === "string" && search.record)
    out.record = search.record;
  const page = Number(search.page);
  if (Number.isInteger(page) && page >= 1) out.page = page;
  return out;
}

export function RecordsPage({ collection }: { collection: CollectionModel }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const search: RecordsSearch = useSearch({ strict: false });
  const isView = collection.type === "view";
  const columnsKey = `heybe_columns_${collection.id}`;
  const [hidden, setHidden] = useState(() => readList(columnsKey));
  const [selected, setSelected] = useState(new Set<string>());
  const [prefill, setPrefill] = useState<
    (Record<string, unknown> & { id: string }) | undefined
  >();

  const page = search.page ?? 1;
  const filter = search.filter ?? "";
  const sort = search.sort ?? "";
  const allFields = (collection.fields as CellField[]).filter((f) => !f.hidden);
  const fields = allFields.filter((f) => !hidden.includes(f.name));
  const expand = expandOf(collection);
  const searchFields = allFields
    .filter((f) => f.type !== "password")
    .map((f) => f.name);
  const query = { page, filter, sort };

  const records = useQuery({
    queryKey: keys.records(collection.id, query),
    queryFn: ({ signal }) =>
      client.records(collection.name).findMany(
        {
          page,
          perPage: 40,
          filter: normalizeSearchFilter(filter, searchFields),
          sort: sort || (isView ? "" : "-@rowid"),
          expand,
        },
        { signal },
      ),
    placeholderData: (previous) => previous,
  });

  const update = (next: RecordsSearch) =>
    navigate({
      to: ".",
      search: (prev: RecordsSearch) =>
        validateRecordsSearch({ ...prev, ...next }),
    });

  const toggleColumn = (name: string) => {
    const next = hidden.includes(name)
      ? hidden.filter((h) => h !== name)
      : [...hidden, name];
    setHidden(next);
    writeList(columnsKey, next);
  };

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const deleteSelected = async () => {
    const ids = [...selected];
    const ok = await confirm({
      title: "Delete records",
      message: `Delete ${ids.length} selected record${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await Promise.all(
        ids.map((id) => client.records(collection.name).delete(id)),
      );
      toast.success("Records deleted.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
    setSelected(new Set());
    await queryClient.invalidateQueries({
      queryKey: ["records", collection.id],
    });
  };

  const rows = (records.data?.items ?? []) as (Record<string, unknown> & {
    id: string;
  })[];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {selected.size > 0 && (
          <Button variant="danger" onClick={deleteSelected}>
            Delete selected ({selected.size})
          </Button>
        )}
        <ColumnsMenu
          names={allFields.map((f) => f.name)}
          hidden={hidden}
          onToggle={toggleColumn}
        />
        {!isView && (
          <Button
            variant="primary"
            onClick={() => {
              setPrefill(undefined);
              update({ record: "new" });
            }}
          >
            New record
          </Button>
        )}
      </div>
      <SearchBar
        filter={filter}
        error={records.error ? errorMessage(records.error) : undefined}
        onSearch={(value) => {
          setSelected(new Set());
          update({ filter: value, page: 1 });
        }}
      />
      {records.data &&
        (rows.length === 0 ? (
          <EmptyState title="No records found" />
        ) : (
          <RecordsTable
            caption={`${collection.name} records`}
            fields={fields}
            rows={rows}
            sort={sort}
            selected={selected}
            onSort={(value) => {
              setSelected(new Set());
              update({ sort: value, page: 1 });
            }}
            onSelect={toggleSelected}
            onSelectAll={(all) =>
              setSelected(new Set(all ? rows.map((r) => r.id) : []))
            }
            onOpen={(id) => update({ record: id })}
          />
        ))}
      {records.data && (
        <Pagination
          page={records.data.page}
          totalPages={records.data.totalPages}
          totalItems={records.data.totalItems}
          onPage={(value) => {
            setSelected(new Set());
            update({ page: value });
          }}
        />
      )}
      {search.record && (
        <RecordEditor
          key={search.record}
          collection={collection}
          recordId={search.record}
          prefill={prefill}
          onClose={() => update({ record: undefined })}
          onDuplicate={(record) => {
            setPrefill(record);
            update({ record: "new" });
          }}
        />
      )}
    </div>
  );
}
