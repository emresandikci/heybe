import type { CollectionModel } from "@heybejs/client";
import { Dialog, Table, Td, Th } from "@heybejs/ui";

export function OverviewDialog({
  collections,
  onClose,
}: {
  collections: CollectionModel[];
  onClose: () => void;
}) {
  const nameOf = (id: unknown) =>
    collections.find((c) => c.id === id)?.name ?? String(id);
  return (
    <Dialog open onClose={onClose} title="Collections overview">
      <Table caption="Collections and their relations">
        <thead>
          <tr>
            <Th>Collection</Th>
            <Th>Type</Th>
            <Th>Relations</Th>
          </tr>
        </thead>
        <tbody>
          {collections.map((c) => (
            <tr key={c.id}>
              <Td>{c.name}</Td>
              <Td>{c.type}</Td>
              <Td>
                {c.fields
                  .filter((f) => f.type === "relation")
                  .map((f) => `${String(f.name)}: ${nameOf(f.collectionId)}`)
                  .join(", ")}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Dialog>
  );
}
