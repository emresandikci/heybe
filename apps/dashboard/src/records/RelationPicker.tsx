import type { CollectionModel } from "@heybe/client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, Dialog, TextField } from "@heybe/ui";
import { presentableLabel } from "./cell";
import { normalizeSearchFilter } from "./search-filter";

type Rec = Record<string, unknown>;

export function RelationPicker({
  title,
  target,
  selected,
  known,
  maxSelect,
  onClose,
  onSelect,
}: {
  title: string;
  target: CollectionModel;
  selected: string[];
  known: Map<string, Rec>;
  maxSelect: number;
  onClose: () => void;
  onSelect: (records: Rec[]) => void;
}) {
  const client = useClient();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<Map<string, Rec>>(
    () => new Map(selected.map((id) => [id, known.get(id) ?? { id }])),
  );
  const fields = (
    target.fields as { name: string; hidden?: boolean; type: string }[]
  )
    .filter((f) => !f.hidden && f.type !== "password")
    .map((f) => f.name);

  const records = useInfiniteQuery({
    queryKey: ["records", target.id, "picker", filter],
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      client.records(target.name).findMany(
        {
          page: pageParam,
          perPage: 40,
          filter: normalizeSearchFilter(filter, fields),
          sort: "-@rowid",
        },
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.totalPages ? last.page + 1 : undefined,
  });

  const items = (records.data?.pages ?? []).flatMap((p) => p.items) as Rec[];
  const single = maxSelect <= 1;
  const full = chosen.size >= maxSelect;

  const toggle = (item: Rec) =>
    setChosen((prev) => {
      if (single) return new Map([[item.id as string, item]]);
      const next = new Map(prev);
      if (!next.delete(item.id as string)) next.set(item.id as string, item);
      return next;
    });

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onSelect([...chosen.values()])}
          >
            Select
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="Search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setFilter(text.trim());
            }
          }}
        />
        {records.isError && <p role="alert">{errorMessage(records.error)}</p>}
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const id = item.id as string;
            const label = presentableLabel(target, item, id);
            const checked = chosen.has(id);
            return (
              <li key={id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type={single ? "radio" : "checkbox"}
                    name="picker"
                    checked={checked}
                    disabled={!single && full && !checked}
                    onChange={() => toggle(item)}
                  />
                  {label}
                </label>
              </li>
            );
          })}
        </ul>
        {records.hasNextPage && (
          <Button
            loading={records.isFetchingNextPage}
            onClick={() => void records.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </div>
    </Dialog>
  );
}
