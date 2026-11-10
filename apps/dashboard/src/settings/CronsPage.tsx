import { useQuery } from "@tanstack/react-query";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { keys } from "../app/queries";
import { Button } from "../ui/Button";
import { Table, Td, Th } from "../ui/Table";
import { useToast } from "../ui/Toasts";

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

  if (!crons.data) return null;
  return (
    <Table caption="Crons">
      <thead>
        <tr>
          <Th>ID</Th>
          <Th>Schedule</Th>
          <Th>
            <span className="sr-only">Actions</span>
          </Th>
        </tr>
      </thead>
      <tbody>
        {crons.data.map((cron) => (
          <tr key={cron.id}>
            <Td>{cron.id}</Td>
            <Td>{cron.expression}</Td>
            <Td>
              <Button onClick={() => void run(cron.id)}>Run now</Button>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
