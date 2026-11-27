import type { CollectionModel } from "@heybejs/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { filterError } from "../app/errors";
import { keys, useCollections } from "../app/queries";
import { Inbox, SearchX, Settings } from "lucide-react";
import { Button, EmptyState, Tooltip, useConfirm, useToast } from "@heybejs/ui";
import { Page } from "../layout/Page";
import { ApiPreview } from "../collections/ApiPreview";
import { useOpenEditor } from "../collections/CollectionsSidebar";
import { useHideControls } from "../settings/use-settings";
import { ColumnsMenu } from "./ColumnsMenu";
import { Pagination } from "./Pagination";
import { RecordEditor } from "./RecordEditor";
import { RecordsTable } from "./RecordsTable";
import { createSuggest } from "../filter-language";
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
  const openEditor = useOpenEditor();
  const hideControls = useHideControls();
  const [preview, setPreview] = useState(false);
  const navigate = useNavigate();
  const search: RecordsSearch = useSearch({ strict: false });
  const isView = collection.type === "view";
  const columnsKey = `hb_columns_${collection.id}`;
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
  const collections = useCollections();
  const suggest = createSuggest({
    collectionId: collection.id,
    fields: allFields,
    collections: collections.data,
  });
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
    const results = await Promise.allSettled(
      ids.map((id) => client.records(collection.name).delete(id)),
    );
    const failed = new Set(
      ids.filter((_, i) => results[i]!.status === "rejected"),
    );
    if (failed.size === 0) toast.success("Records deleted.");
    else {
      const deleted = ids.length - failed.size;
      toast.error(
        `Deleted ${deleted} of ${ids.length} records, ${failed.size} failed.`,
      );
    }
    setSelected(failed);
    await queryClient.invalidateQueries({
      queryKey: ["records", collection.id],
    });
  };

  const newRecord = () => {
    setPrefill(undefined);
    update({ record: "new" });
  };

  const rows = (records.data?.items ?? []) as (Record<string, unknown> & {
    id: string;
  })[];

  const content = () => {
    if (records.isError)
      return (
        <EmptyState title="Could not load records">
          {filter && (
            <Button onClick={() => update({ filter: "", page: 1 })}>
              Clear filter
            </Button>
          )}
        </EmptyState>
      );
    if (!records.data)
      return (
        <p role="status" className="text-sm text-muted">
          Loading...
        </p>
      );
    if (rows.length === 0)
      return filter ? (
        <EmptyState
          title="No records match this filter"
          icon={<SearchX size={15} strokeWidth={1.75} aria-hidden />}
        />
      ) : (
        <EmptyState
          title="No records yet"
          icon={<Inbox size={15} strokeWidth={1.75} aria-hidden />}
        >
          {!isView && (
            <Button variant="primary" onClick={newRecord}>
              New record
            </Button>
          )}
        </EmptyState>
      );
    return (
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
        selectable={!isView}
        onSelect={toggleSelected}
        onSelectAll={(all) =>
          setSelected(new Set(all ? rows.map((r) => r.id) : []))
        }
        onOpen={(id) => update({ record: id })}
      />
    );
  };

  return (
    <Page
      width="full"
      crumbs={[
        { label: "Collections", to: "/collections" },
        { label: collection.name },
      ]}
      footer={
        records.data && !records.isError
          ? `Total: ${records.data.totalItems}`
          : undefined
      }
      actions={
        <>
          {selected.size > 0 && (
            <Button variant="danger" onClick={deleteSelected}>
              Delete selected ({selected.size})
            </Button>
          )}
          <Button onClick={() => setPreview(true)}>API preview</Button>
          <ColumnsMenu
            names={allFields.map((f) => f.name)}
            hidden={hidden}
            onToggle={toggleColumn}
          />
          {!isView && (
            <Button variant="primary" onClick={newRecord}>
              New record
            </Button>
          )}
          {!hideControls && (
            <Tooltip content={`Edit ${collection.name}`}>
              <Button
                aria-label={`Edit ${collection.name}`}
                onClick={() => openEditor(collection)}
                icon={<Settings aria-hidden size={15} strokeWidth={1.75} />}
              />
            </Tooltip>
          )}
        </>
      }
    >
      <SearchBar
        filter={filter}
        suggest={suggest}
        error={records.error ? filterError(records.error) : undefined}
        onSearch={(value) => {
          setSelected(new Set());
          update({ filter: value, page: 1 });
        }}
      />
      {content()}
      {preview && (
        <ApiPreview collection={collection} onClose={() => setPreview(false)} />
      )}
      {records.data && !records.isError && (
        <Pagination
          page={records.data.page}
          totalPages={records.data.totalPages}
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
    </Page>
  );
}
