import type { SqlResult } from "@heybejs/client";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { useCollections, useSqlSchema } from "../app/queries";
import { QueryStatus } from "./QueryStatus";
import { SettingsPage } from "./SettingsPage";
import { Button, CodeArea, Table, Td, Th, useConfirm } from "@heybejs/ui";

const CODE_ONLY =
  /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g;

export function changesRows(query: string): boolean {
  // replace() is also a string function, so only the statement forms count
  return /\b(delete|update|drop|alter)\b|\b(replace\s+into|or\s+replace)\b/i.test(
    query.replace(CODE_ONLY, " "),
  );
}

export function SqlPage() {
  const client = useClient();
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState("");
  const confirm = useConfirm();
  const collections = useCollections();
  const schema = useSqlSchema();

  const form = useForm({
    defaultValues: { query: "" },
    onSubmit: async ({ value }) => {
      if (!value.query.trim()) return;
      setError("");
      if (
        changesRows(value.query) &&
        !(await confirm({
          title: "Run query",
          message:
            "This query changes or removes data or tables. It cannot be undone. Run it?",
          confirmLabel: "Run",
          danger: true,
        }))
      )
        return;
      try {
        setResult(await client.sql.run(value.query));
      } catch (err) {
        setResult(null);
        setError(errorMessage(err));
      }
    },
  });

  return (
    <SettingsPage title="SQL" width="full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="flex flex-col gap-3"
      >
        {collections.isError && <QueryStatus query={collections} />}
        <p className="rounded-control border border-warning-line bg-warning-bg p-3 text-sm text-warning-text">
          Queries run directly on the database. They skip API rules, hooks and
          migrations.
        </p>
        <form.Field name="query">
          {(field) => (
            <CodeArea
              label="SQL query"
              language="sql"
              sqlSchema={schema}
              rows={8}
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value);
                setError("");
              }}
              onRun={() => void form.handleSubmit()}
            />
          )}
        </form.Field>
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button
              type="submit"
              className="self-start"
              variant="primary"
              loading={isSubmitting}
            >
              Run
            </Button>
          )}
        </form.Subscribe>
        {error && (
          <div
            role="alert"
            className="rounded border border-danger/40 bg-danger/10 p-3 text-sm text-danger-text"
          >
            {error}
          </div>
        )}
        {result && (
          <>
            <p className="text-sm">
              {result.rows.length} rows, {result.affectedRows} affected,{" "}
              {result.execTime} ms
            </p>
            {result.columns.length > 0 && (
              <Table caption="Result">
                <thead>
                  <tr>
                    {result.columns.map((c, i) => (
                      <Th key={i}>{c.name}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <Td key={j}>{cell === null ? "NULL" : cell}</Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </form>
    </SettingsPage>
  );
}
