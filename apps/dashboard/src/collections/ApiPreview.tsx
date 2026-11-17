import type { CollectionModel } from "@heybe/client";
import { CopyButton, Dialog, Table, Td, Th } from "@heybe/ui";

function ruleText(rule: unknown): string {
  if (rule === null || rule === undefined) return "Superusers only";
  if (rule === "") return "Everyone";
  return String(rule);
}

export function ApiPreview({
  collection: c,
  onClose,
}: {
  collection: CollectionModel;
  onClose: () => void;
}) {
  const base = `/api/collections/${encodeURIComponent(c.name)}`;
  const endpoints: [string, string, string, unknown][] = [
    ["List/Search", "GET", `${base}/records`, c.listRule],
    ["View", "GET", `${base}/records/{id}`, c.viewRule],
  ];
  if (c.type !== "view")
    endpoints.push(
      ["Create", "POST", `${base}/records`, c.createRule],
      ["Update", "PATCH", `${base}/records/{id}`, c.updateRule],
      ["Delete", "DELETE", `${base}/records/{id}`, c.deleteRule],
    );
  if (c.type === "auth")
    endpoints.push([
      "Auth with password",
      "POST",
      `${base}/auth-with-password`,
      c.authRule,
    ]);
  const snippet = [
    'import { createClient } from "@heybe/client";',
    "",
    `const heybe = createClient(${JSON.stringify(location.origin)});`,
    `const page = await heybe.records(${JSON.stringify(c.name)}).findMany({ page: 1, perPage: 20 });`,
  ].join("\n");

  return (
    <Dialog open onClose={onClose} title="API preview">
      <Table caption={`${c.name} endpoints`}>
        <thead>
          <tr>
            <Th>Action</Th>
            <Th>Method</Th>
            <Th>Path</Th>
            <Th>Rule</Th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map(([action, method, path, rule]) => (
            <tr key={action}>
              <Td>{action}</Td>
              <Td>{method}</Td>
              <Td>
                <code>{path}</code>
              </Td>
              <Td>{ruleText(rule)}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <div className="mt-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">Client</h3>
        <CopyButton text={snippet} label="Copy snippet" />
      </div>
      <pre className="mt-1 overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">
        <code>{snippet}</code>
      </pre>
    </Dialog>
  );
}
