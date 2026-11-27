import type { CollectionModel } from "@heybejs/client";
import {
  Badge,
  CodeArea,
  CopyButton,
  Dialog,
  Table,
  Td,
  Th,
} from "@heybejs/ui";

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
    'import { createClient } from "@heybejs/client";',
    "",
    `const heybe = createClient(${JSON.stringify(location.origin)});`,
    `const page = await heybe.records(${JSON.stringify(c.name)}).findMany({ page: 1, perPage: 20 });`,
  ].join("\n");

  return (
    <Dialog open size="lg" onClose={onClose} title="API preview">
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
            <tr key={action} className="h-11">
              <Td>{action}</Td>
              <Td>
                <Badge tone="neutral">{method}</Badge>
              </Td>
              <Td wrap>
                <span className="flex items-center gap-1">
                  <code className="min-w-0 max-w-md truncate" title={path}>
                    {path}
                  </code>
                  <CopyButton text={path} label={`Copy ${action} path`} />
                </span>
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
      <div className="mt-1">
        <CodeArea
          label="Client snippet"
          hideLabel
          language="javascript"
          readOnly
          value={snippet}
        />
      </div>
    </Dialog>
  );
}
