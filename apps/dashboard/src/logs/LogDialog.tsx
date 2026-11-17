import { useQuery } from "@tanstack/react-query";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button, CopyButton, Dialog } from "@heybe/ui";
import { levelName } from "./level";

const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

export function LogDialog({ id, onClose }: { id: string; onClose(): void }) {
  const client = useClient();
  const log = useQuery({
    queryKey: ["logs", "one", id],
    queryFn: ({ signal }) => client.logs.findOne(id, { signal }),
  });
  const entries: [string, string][] = log.data
    ? [
        ["id", log.data.id],
        ["created", log.data.created],
        ["level", levelName(log.data.level)],
        ["message", log.data.message],
        ...Object.entries(log.data.data).map(
          ([key, value]): [string, string] => [key, text(value)],
        ),
      ]
    : [];
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
              text={JSON.stringify(log.data, null, 2)}
            />
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {log.error && <p role="alert">{errorMessage(log.error)}</p>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="font-medium">{key}</dt>
            <dd className="break-all whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
