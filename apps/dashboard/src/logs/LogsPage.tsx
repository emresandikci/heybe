import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useClient } from "../app/context";
import { filterError } from "../app/errors";
import { formatDate } from "../app/format";
import { Page } from "../layout/Page";
import { createSuggest, logsSchema } from "../filter-language";
import { SearchBar } from "../records/SearchBar";

const suggest = createSuggest(logsSchema);
import { QueryStatus } from "../settings/QueryStatus";
import { useSettings } from "../settings/use-settings";
import { Button, Checkbox, Table, Td, Th } from "@heybejs/ui";
import { LogDialog } from "./LogDialog";
import { LogsChart } from "./LogsChart";
import { LogsSettingsDialog } from "./LogsSettingsDialog";
import { LevelBadge } from "./LevelBadge";

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

function summary(log: { message: string; data: Record<string, unknown> }) {
  const { method, url, status, execTime } = log.data;
  if (!method) return log.message;
  const duration =
    typeof execTime === "number" ? `${Math.round(execTime)}ms` : "";
  return [text(method), text(status), duration, text(url)]
    .filter(Boolean)
    .join(" ");
}

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
    <Page
      crumbs={[{ label: "Logs" }]}
      width="full"
      footer={list.data && `Total: ${list.data.pages[0]!.totalItems}`}
      actions={
        <>
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
        </>
      }
    >
      <SearchBar
        label="Filter logs"
        suggest={suggest}
        placeholder="e.g. level >= 8 && data.status >= 400"
        filter={search.filter ?? ""}
        error={list.error ? filterError(list.error) : undefined}
        onSearch={(next) => void update({ filter: next || undefined })}
      />
      <Checkbox
        label="Include superuser requests"
        checked={!!search.superusers}
        onChange={(e) =>
          void update({ superusers: e.target.checked || undefined })
        }
      />
      {(stats.data || list.error) && <LogsChart stats={stats.data ?? []} />}
      {stats.isError && !list.error && <QueryStatus query={stats} />}
      {list.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading...
        </p>
      )}
      {items?.length === 0 && (
        <p className="text-sm text-muted">
          {search.filter ? "No logs match the filter." : "No logs yet."}
        </p>
      )}
      {((items && items.length > 0) || list.error) && (
        <Table caption="Logs">
          <thead>
            <tr>
              <Th>Level</Th>
              <Th>Message</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody>
            {(items ?? []).map((log) => (
              <tr
                key={log.id}
                className="cursor-pointer hover:bg-hover"
                onClick={() => void update({ log: log.id })}
              >
                <Td>
                  <LevelBadge level={log.level} />
                </Td>
                <Td fill>
                  <button
                    type="button"
                    title={summary(log)}
                    className="block w-full truncate text-left font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus"
                    onClick={(e) => {
                      e.stopPropagation();
                      void update({ log: log.id });
                    }}
                  >
                    {summary(log)}
                  </button>
                </Td>
                <Td>
                  <span
                    title={log.created}
                    className="whitespace-nowrap text-muted"
                  >
                    {formatDate(log.created)}
                  </span>
                </Td>
              </tr>
            ))}
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
    </Page>
  );
}
