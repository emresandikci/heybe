import type { SqlResult } from "@heybe/client";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { useClient } from "../app/context";
import { errorMessage } from "../app/errors";
import { Button } from "../ui/Button";
import { CodeArea } from "../ui/CodeArea";
import { Table, Td, Th } from "../ui/Table";

export function SqlPage() {
  const client = useClient();
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState("");

  const form = useForm({
    defaultValues: { query: "" },
    onSubmit: async ({ value }) => {
      if (!value.query.trim()) return;
      setError("");
      try {
        setResult(await client.sql.run(value.query));
      } catch (err) {
        setResult(null);
        setError(errorMessage(err));
      }
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="flex flex-col gap-3"
    >
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        Queries run directly on the database. They skip API rules, hooks and
        migrations.
      </p>
      <form.Field name="query">
        {(field) => (
          <CodeArea
            label="SQL query"
            language="sql"
            rows={8}
            value={field.state.value}
            onChange={field.handleChange}
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
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
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
  );
}
