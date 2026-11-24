import { useQuery } from "@tanstack/react-query";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { formatDate } from "../app/format";
import { Button, CopyButton, Dialog } from "@heybe/ui";
import { levelName } from "./level";

const text = (value: unknown) =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

export function LogDialog({ id, onClose }: { id: string; onClose(): void }) {
  const client = useClient();
  const log = useQuery({
    queryKey: ["logs", "one", id],
    queryFn: ({ signal }) => client.logs.findOne(id, { signal }),
  });
  const entries: [string, string][] = log.data
    ? [
        ["id", log.data.id],
        ["created", formatDate(log.data.created, "full")],
        ["level", levelName(log.data.level)],
        ["message", log.data.message],
        ...Object.entries(log.data.data).map(
          ([key, value]): [string, string] => [key, text(value)],
        ),
      ]
    : [];
  const shown = entries.filter(([, value]) => value !== "");
  return (
    <Dialog
      open
      onClose={onClose}
      title="Log details"
      footer={
        <>
          {log.data && (
            <CopyButton
              label="Copy JSON"
              showLabel
              text={JSON.stringify(log.data, null, 2)}
            />
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {log.isPending && (
        <p role="status" className="text-sm text-muted">
          Loading...
        </p>
      )}
      {log.error && <p role="alert">{errorMessage(log.error)}</p>}
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {shown.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate font-medium text-muted" title={key}>
              {key}
            </dt>
            <dd className="min-w-0 whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
