import { useQuery } from "@tanstack/react-query";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { keys } from "../app/queries";
import { Button, Table, Td, Th, useToast } from "@heybe/ui";
import { describeCron } from "./cron-text";
import { QueryStatus } from "./QueryStatus";
import { SettingsPage } from "./SettingsPage";

export function CronsPage() {
  const client = useClient();
  const toast = useToast();
  const crons = useQuery({
    queryKey: keys.crons,
    queryFn: ({ signal }) => client.crons.list({ signal }),
  });

  const run = async (id: string) => {
    try {
      await client.crons.run(id);
      toast.success(`Started ${id}.`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  if (!crons.data)
    return (
      <SettingsPage title="Crons">
        <QueryStatus query={crons} />
      </SettingsPage>
    );
  return (
    <SettingsPage title="Crons">
      <Table caption="Crons">
        <thead>
          <tr>
            <Th>ID</Th>
            <Th>Schedule</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {crons.data.map((cron) => {
            const text = describeCron(cron.expression);
            return (
              <tr key={cron.id}>
                <Td>
                  <span className="font-mono text-xs">{cron.id}</span>
                </Td>
                <Td>
                  <span className="font-mono text-xs">{cron.expression}</span>
                  {text && <span className="ml-2 text-muted">{text}</span>}
                </Td>
                <Td align="right">
                  <Button onClick={() => void run(cron.id)}>Run now</Button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </SettingsPage>
  );
}
