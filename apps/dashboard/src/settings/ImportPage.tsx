import type { CollectionModel } from "@heybe/client";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { useId, useRef, useState, type ChangeEvent } from "react";
import { useClient } from "../app/context";
import { errorMessage, flattenErrors, responseData } from "../app/errors";
import { keys, useCollections } from "../app/queries";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { CodeArea } from "../ui/CodeArea";
import { useConfirm } from "../ui/Confirm";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../ui/Toasts";
import {
  diffImport,
  parseImport,
  type CollectionChange,
  type ImportDiff,
} from "./import-diff";
import { useSettings } from "./use-settings";

interface Review {
  list: Partial<CollectionModel>[];
  diff: ImportDiff;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ImportPage() {
  const client = useClient();
  const settings = useSettings();
  const collections = useCollections();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<{ message: string; details: string[] }>();
  const [review, setReview] = useState<Review | null>(null);

  const form = useForm({
    defaultValues: { text: "", deleteMissing: false },
    onSubmitMeta: { step: "review" } as { step: "review" | "import" },
    onSubmit: async ({ value, meta }) => {
      if (meta.step === "review") openReview(value);
      else if (review) await runImport(review, value.deleteMissing);
    },
  });

  if (!settings.data) return null;
  if (settings.data.meta.hideControls)
    return <EmptyState title="Collection controls are hidden." />;

  const load = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    form.setFieldValue("text", await file.text());
    setError(undefined);
  };

  const openReview = ({
    text,
    deleteMissing,
  }: {
    text: string;
    deleteMissing: boolean;
  }) => {
    try {
      const list = parseImport(text);
      setError(undefined);
      setReview({
        list,
        diff: diffImport(collections.data ?? [], list, deleteMissing),
      });
    } catch (err) {
      setError({ message: errorMessage(err), details: [] });
    }
  };

  const runImport = async ({ list, diff }: Review, deleteMissing: boolean) => {
    setReview(null);
    const fields = diff.changed.reduce(
      (n, c) => n + c.fields.deleted.length,
      0,
    );
    if (diff.deleted.length + fields > 0) {
      const ok = await confirm({
        title: "Delete data",
        message: `This import deletes ${[
          diff.deleted.length > 0 && plural(diff.deleted.length, "collection"),
          fields > 0 && plural(fields, "field"),
        ]
          .filter(Boolean)
          .join(" and ")} with all their data. This cannot be undone.`,
        confirmLabel: "Import and delete",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await client.collections.import(list, deleteMissing);
      await queryClient.invalidateQueries({ queryKey: keys.collections });
      toast.success("Collections imported.");
    } catch (err) {
      setError({
        message: errorMessage(err),
        details: Object.values(flattenErrors(responseData(err))),
      });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit({ step: "review" });
      }}
      className="flex flex-col gap-3"
    >
      <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        Imports do not write migration files. Run{" "}
        <code>heybe migrate collections</code> afterwards to snapshot the
        schema.
      </p>
      <div>
        <Button onClick={() => fileInput.current?.click()}>
          Load from file
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Collections file"
          className="hidden"
          onChange={(e) => void load(e)}
        />
      </div>
      <form.Field name="text">
        {(field) => (
          <CodeArea
            label="Collections JSON"
            language="json"
            rows={16}
            value={field.state.value}
            onChange={(value) => {
              field.handleChange(value);
              setError(undefined);
            }}
          />
        )}
      </form.Field>
      <form.Field name="deleteMissing">
        {(field) => (
          <Checkbox
            label="Delete collections and fields missing from the import"
            hint="System collections and system fields are never deleted."
            checked={field.state.value}
            onChange={(e) => field.handleChange(e.target.checked)}
          />
        )}
      </form.Field>
      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <p>{error.message}</p>
          {error.details.map((d, i) => (
            <pre key={i} className="mt-2 whitespace-pre-wrap text-xs">
              {d}
            </pre>
          ))}
        </div>
      )}
      <form.Subscribe
        selector={(s) => [s.isSubmitting, !s.values.text.trim()] as const}
      >
        {([isSubmitting, noText]) => (
          <Button
            type="submit"
            className="self-start"
            variant="primary"
            loading={isSubmitting}
            disabled={noText || !collections.data}
          >
            Review
          </Button>
        )}
      </form.Subscribe>
      {review && (
        <ReviewDialog
          diff={review.diff}
          onCancel={() => setReview(null)}
          onImport={() => void form.handleSubmit({ step: "import" })}
        />
      )}
    </form>
  );
}

function ReviewDialog({
  diff,
  onCancel,
  onImport,
}: {
  diff: ImportDiff;
  onCancel: () => void;
  onImport: () => void;
}) {
  const empty =
    diff.added.length + diff.changed.length + diff.deleted.length === 0;
  const deletes =
    diff.deleted.length > 0 ||
    diff.changed.some((c) => c.fields.deleted.length > 0);
  return (
    <Dialog
      open
      onClose={onCancel}
      title="Review import"
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={empty} onClick={onImport}>
            Import
          </Button>
        </>
      }
    >
      {empty && <p className="text-sm">No changes.</p>}
      <Section title="Added" items={diff.added.map((name) => ({ name }))} />
      <Section title="Changed" items={diff.changed.map(changeItem)} />
      <Section title="Deleted" items={diff.deleted.map((name) => ({ name }))} />
      {deletes && (
        <p className="mt-3 text-sm text-red-700 dark:text-red-300">
          Deleted collections and fields lose all their data.
        </p>
      )}
    </Dialog>
  );
}

function changeItem(change: CollectionChange) {
  const { added, changed, deleted } = change.fields;
  return {
    name: change.previousName
      ? `${change.previousName} -> ${change.name}`
      : change.name,
    lines: [
      added.length > 0 && `Added fields: ${added.join(", ")}`,
      changed.length > 0 && `Changed fields: ${changed.join(", ")}`,
      deleted.length > 0 && `Deleted fields: ${deleted.join(", ")}`,
    ].filter((line): line is string => !!line),
  };
}

function Section({
  title,
  items,
}: {
  title: string;
  items: { name: string; lines?: string[] }[];
}) {
  const id = useId();
  if (items.length === 0) return null;
  const heading = `${title} (${items.length})`;
  return (
    <section className="mt-3 first:mt-0">
      <h3 id={id} className="text-sm font-semibold">
        {heading}
      </h3>
      <ul aria-labelledby={id} className="mt-1 list-disc pl-5 text-sm">
        {items.map((item) => (
          <li key={item.name}>
            <span className="font-mono">{item.name}</span>
            {item.lines?.map((line) => (
              <p
                key={line}
                className="text-xs text-slate-600 dark:text-slate-400"
              >
                {line}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
