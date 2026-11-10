import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { SearchBar } from "../records/SearchBar";
import { useSettings } from "../settings/use-settings";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Table, Td, Th } from "../ui/Table";
import { LogDialog } from "./LogDialog";
import { LogsChart } from "./LogsChart";
import { LogsSettingsDialog } from "./LogsSettingsDialog";
import { levelName } from "./level";

export type LogsSearch = {
  filter?: string;
  superusers?: boolean;
  log?: string;
};

export function validateLogsSearch(
  search: Record<string, unknown>,
): LogsSearch {
  const out: LogsSearch = {};
  if (typeof search.filter === "string" && search.filter)
    out.filter = search.filter;
  if (search.superusers === true || search.superusers === "true")
    out.superusers = true;
  if (typeof search.log === "string" && search.log) out.log = search.log;
  return out;
}

const EXCLUDE_SUPERUSERS = 'data.auth != "_superusers"';

function effectiveFilter({ filter, superusers }: LogsSearch): string {
  if (superusers) return filter ?? "";
  return filter ? `(${filter}) && (${EXCLUDE_SUPERUSERS})` : EXCLUDE_SUPERUSERS;
}

const text = (value: unknown) => (value == null ? "" : String(value));

export function LogsPage() {
  const client = useClient();
  const navigate = useNavigate();
  const search: LogsSearch = useSearch({ strict: false });
  const settings = useSettings();
  const [editingSettings, setEditingSettings] = useState(false);
  const filter = effectiveFilter(search);

  const list = useInfiniteQuery({
    queryKey: ["logs", "list", filter],
    initialPageParam: 1,
    queryFn: ({ signal, pageParam }) =>
      client.logs.findMany(
        { perPage: 50, page: pageParam, filter, sort: "-@rowid" },
        { signal },
      ),
    getNextPageParam: (last) =>
      last.page < last.totalPages ? last.page + 1 : undefined,
  });
  const stats = useQuery({
    queryKey: ["logs", "stats", filter],
    queryFn: ({ signal }) => client.logs.stats({ filter }, { signal }),
  });

  const update = (next: LogsSearch) =>
    navigate({
      to: ".",
      search: (prev: LogsSearch) => validateLogsSearch({ ...prev, ...next }),
    });

  const items = list.data?.pages.flatMap((p) => p.items);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Logs</h2>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              void list.refetch();
              void stats.refetch();
            }}
          >
            Refresh
          </Button>
          <Button
            disabled={!settings.data}
            onClick={() => setEditingSettings(true)}
          >
            Logs settings
          </Button>
        </div>
      </div>
      <SearchBar
        label="Filter logs"
        filter={search.filter ?? ""}
        error={list.error ? errorMessage(list.error) : undefined}
        onSearch={(next) => void update({ filter: next || undefined })}
      />
      <Checkbox
        label="Include superuser requests"
        checked={!!search.superusers}
        onChange={(e) =>
          void update({ superusers: e.target.checked || undefined })
        }
      />
      {stats.data && <LogsChart stats={stats.data} />}
      {items && (
        <Table caption="Logs">
          <thead>
            <tr>
              <Th>Level</Th>
              <Th>Message</Th>
              <Th>Request</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((log) => {
              const { method, url, status } = log.data;
              const request = method
                ? [text(method), text(url), text(status)]
                    .filter(Boolean)
                    .join(" ")
                : "";
              return (
                <tr key={log.id}>
                  <Td>{levelName(log.level)}</Td>
                  <Td>
                    <button
                      type="button"
                      className="text-left underline"
                      onClick={() => void update({ log: log.id })}
                    >
                      {log.message}
                    </button>
                  </Td>
                  <Td>{request}</Td>
                  <Td>{log.created}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          className="self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Load more
        </Button>
      )}
      {search.log && (
        <LogDialog
          id={search.log}
          onClose={() => void update({ log: undefined })}
        />
      )}
      {editingSettings && settings.data && (
        <LogsSettingsDialog
          settings={settings.data}
          onClose={() => setEditingSettings(false)}
        />
      )}
    </div>
  );
}
