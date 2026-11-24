import type { CollectionModel } from "@heybe/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-form";
import { MoreHorizontal } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useClient } from "../app/context";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  flattenErrors,
  responseData,
  useFieldError,
} from "../app/errors";
import { keys, useCollections, useSqlSchema } from "../app/queries";
import {
  Button,
  CodeArea,
  Dialog,
  Menu,
  Select,
  Tabs,
  TextField,
  useConfirm,
  useToast,
} from "@heybe/ui";
import { QueryStatus } from "../settings/QueryStatus";
import { ChangesDialog } from "./ChangesDialog";
import {
  diffCollection,
  duplicateDraft,
  draftFrom,
  finalIndexes,
  hasChanges,
  newDraft,
  newField,
  renameCollection,
  setIndexes,
  toPayload,
  useEditorForm,
  type Changes,
  type CollectionDraft,
  type CollectionType,
  type EditorForm,
  type FieldType,
} from "./editor-state";
import { FIELD_TYPES } from "./field-types";
import { FieldRow } from "./fields/FieldRow";
import { IndexesEditor } from "./IndexesEditor";
import { parseIndex } from "./index-sql";
import { viewCompletions } from "./sql-completions";
import { RULE_KEYS, RulesTab } from "./rules/RulesTab";
import { AuthOptions } from "./auth/AuthOptions";
import { TemplateStoreProvider, useTemplateStore } from "./auth/TemplateBody";

const AUTH_OPTION_KEYS = [
  "authAlert",
  "oauth2",
  "passwordAuth",
  "mfa",
  "otp",
  "authToken",
  "passwordResetToken",
  "emailChangeToken",
  "verificationToken",
  "fileToken",
  "verificationTemplate",
  "resetPasswordTemplate",
  "confirmEmailChangeTemplate",
];

function tabOf(path: string): string | null {
  const top = path.split(".")[0]!;
  if (RULE_KEYS.includes(top)) return "rules";
  if (["fields", "indexes", "viewQuery"].includes(top)) return "fields";
  if (AUTH_OPTION_KEYS.includes(top)) return "options";
  return null;
}

const same = (a: CollectionDraft, b: CollectionDraft) =>
  JSON.stringify(toPayload(a)) === JSON.stringify(toPayload(b));

function useScaffolds(enabled: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: ["collectionScaffolds"],
    queryFn: ({ signal }) => client.collections.scaffolds({ signal }),
    enabled,
  });
}

export function CollectionEditor({
  collection,
  onClose,
}: {
  collection?: CollectionModel;
  onClose: () => void;
}) {
  const scaffolds = useScaffolds(!collection);
  if (!collection && !scaffolds.data)
    return (
      <Dialog open variant="side" onClose={onClose} title="New collection">
        <QueryStatus query={scaffolds} />
      </Dialog>
    );
  return <Editor collection={collection} onClose={onClose} />;
}

function Editor({
  collection,
  onClose,
}: {
  collection?: CollectionModel;
  onClose: () => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { collectionId } = useParams({ strict: false });
  const confirm = useConfirm();
  const toast = useToast();
  const formId = useId();
  const [source, setSource] = useState(collection);
  const scaffolds = useScaffolds(!source);
  const [initial, setInitial] = useState(() =>
    collection ? draftFrom(collection) : newDraft("base", scaffolds.data!),
  );
  const [selectedTab, setTab] = useState("fields");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Changes | null>(null);
  const templates = useTemplateStore();

  const save = async (draft: CollectionDraft) => {
    setPending(null);
    setError(null);
    try {
      const payload = toPayload(draft);
      const saved = source
        ? await client.collections.update(source.id, payload)
        : await client.collections.create(payload);
      // move a URL holding the old name to the id before the list refetches, or the page
      // (and the button the editor returns focus to) unmounts as "not found"
      if (source && collectionId === source.name && saved.name !== source.name)
        await navigate({
          to: "/collections/$collectionId",
          params: { collectionId: saved.id },
          replace: true,
        });
      await queryClient.invalidateQueries({ queryKey: keys.collections });
      await queryClient.invalidateQueries({ queryKey: ["records", saved.id] });
      toast.success(source ? "Collection saved." : "Collection created.");
      onClose();
      if (!source)
        void navigate({
          to: "/collections/$collectionId",
          params: { collectionId: saved.id },
        });
    } catch (err) {
      setError(err);
      const withErrors = Object.keys(flattenErrors(responseData(err))).map(
        tabOf,
      );
      const first = withErrors.find((t) => t !== null);
      if (first && !withErrors.includes(tab)) setTab(first);
    }
  };

  const form = useEditorForm(initial, async (draft, confirmed) => {
    if (templates.invalid || templates.compiling) return;
    if (source && !confirmed) {
      const changes = diffCollection(source, draft);
      if (hasChanges(changes)) return setPending(changes);
    }
    await save(draft);
  });
  const draft = useStore(form.store, (s) => s.values);

  const start = (d: CollectionDraft) => {
    setInitial(d);
    form.reset(d);
    setError(null);
    templates.reset();
  };

  const clearError = () => setError(null);

  const confirmDiscard = async () =>
    same(form.state.values, initial) ||
    (await confirm({
      title: "Discard unsaved changes?",
      message: "Your edits to this collection will be lost.",
      confirmLabel: "Discard",
      danger: true,
    }));

  const requestClose = async () => {
    if (await confirmDiscard()) onClose();
  };

  const changeType = (type: CollectionType) => {
    if (!scaffolds.data) return;
    const current = form.state.values;
    templates.reset();
    const next = renameCollection(newDraft(type, scaffolds.data), current.name);
    if (type === "view") return form.reset(next, { keepDefaultValues: true });
    const scaffolded = new Set(
      scaffolds.data[current.type]!.indexes.map((sql) => parseIndex(sql)?.name),
    );
    const custom = finalIndexes(current).filter(
      (sql) => !scaffolded.has(parseIndex(sql)?.name),
    );
    form.reset(
      setIndexes(
        {
          ...next,
          fields: [...next.fields, ...current.fields.filter((f) => !f.system)],
        },
        [...finalIndexes(next), ...custom],
      ),
      { keepDefaultValues: true },
    );
  };

  const changeIndexes = (indexes: string[]) => {
    clearError();
    const next = setIndexes(form.state.values, indexes);
    form.setFieldValue("_originalName", next._originalName);
    form.setFieldValue("fields", next.fields);
    form.setFieldValue("indexes", next.indexes);
  };

  const duplicate = async () => {
    if (!source || !(await confirmDiscard())) return;
    setSource(undefined);
    start(duplicateDraft(source));
  };
  const truncate = async () => {
    if (!source) return;
    const ok = await confirm({
      title: "Truncate collection",
      message: `Delete all records of ${source.name}? This cannot be undone.`,
      confirmLabel: "Truncate",
      danger: true,
      typeToConfirm: source.name,
    });
    if (!ok) return;
    try {
      await client.collections.truncate(source.id);
      await queryClient.invalidateQueries({ queryKey: ["records"] });
      toast.success("Collection truncated.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async () => {
    if (!source) return;
    const ok = await confirm({
      title: "Delete collection",
      message: `Delete ${source.name} with all its records? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
      typeToConfirm: source.name,
    });
    if (!ok) return;
    try {
      await client.collections.delete(source.id);
      await queryClient.invalidateQueries({ queryKey: keys.collections });
      toast.success("Collection deleted.");
      onClose();
      void navigate({ to: "/collections" });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const system = !!source?.system;
  const tabs = [
    { value: "fields", label: draft.type === "view" ? "Query" : "Fields" },
    { value: "rules", label: "API rules" },
    ...(draft.type === "auth" ? [{ value: "options", label: "Auth" }] : []),
  ];
  const tab = tabs.some((t) => t.value === selectedTab)
    ? selectedTab
    : "fields";

  return (
    <TemplateStoreProvider value={templates.store}>
      <ErrorScope error={error}>
        <Dialog
          open
          variant="side"
          onClose={() => void requestClose()}
          title={source ? `Edit ${source.name}` : "New collection"}
          footer={
            <>
              {source && (
                <div className="mr-auto flex gap-2">
                  <Button onClick={() => void duplicate()}>Duplicate</Button>
                  {!system && source.type !== "view" && (
                    <Menu
                      trigger={
                        <Button
                          aria-label="More actions"
                          icon={<MoreHorizontal size={15} strokeWidth={1.75} />}
                          className="w-9 px-0"
                        />
                      }
                      items={[
                        { key: "truncate", label: "Truncate", danger: true },
                      ]}
                      onAction={() => void truncate()}
                      placement="top-start"
                    />
                  )}
                  {!system && (
                    <Button variant="danger" onClick={() => void remove()}>
                      Delete
                    </Button>
                  )}
                </div>
              )}
              {templates.invalid && (
                <span className="self-center text-sm text-danger-text">
                  Fix the MJML errors in the email templates before saving.
                </span>
              )}
              <Button onClick={() => void requestClose()}>Cancel</Button>
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(isSubmitting) => (
                  <Button
                    type="submit"
                    form={formId}
                    variant="primary"
                    loading={isSubmitting}
                    disabled={templates.invalid || templates.compiling}
                  >
                    {source ? "Save changes" : "Create"}
                  </Button>
                )}
              </form.Subscribe>
            </>
          }
        >
          <form
            id={formId}
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="flex flex-col gap-4"
          >
            <UnclaimedErrors />
            <div className="grid grid-cols-[1fr_9rem] items-start gap-3">
              <div>
                <form.Field name="name">
                  {(field) => (
                    <ScopedTextField
                      label="Name"
                      path="name"
                      value={field.state.value}
                      disabled={system}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
              </div>
              <Select
                label="Type"
                value={draft.type}
                disabled={!!source}
                onChange={(e) => changeType(e.target.value as CollectionType)}
              >
                <option value="base">Base</option>
                <option value="view">View</option>
                <option value="auth">Auth</option>
              </Select>
            </div>
            <Tabs
              label="Collection sections"
              tabs={tabs}
              value={tab}
              onChange={setTab}
            />
            {tab === "fields" &&
              (draft.type === "view" ? (
                <ViewQuery form={form} draft={draft} />
              ) : (
                <FieldsTab
                  form={form}
                  draft={draft}
                  clearError={clearError}
                  onIndexes={changeIndexes}
                />
              ))}
            {tab === "rules" && <RulesTab form={form} draft={draft} />}
            {tab === "options" && (
              <AuthOptions
                form={form}
                draft={draft}
                clearError={clearError}
                saved={source}
              />
            )}
          </form>
        </Dialog>
        {pending && (
          <ChangesDialog
            changes={pending}
            onCancel={() => setPending(null)}
            onConfirm={() => void form.handleSubmit({ confirmed: true })}
          />
        )}
      </ErrorScope>
    </TemplateStoreProvider>
  );
}

function ScopedTextField({
  label,
  path,
  value,
  disabled,
  onChange,
}: {
  label: string;
  path: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <TextField
      label={label}
      value={value}
      disabled={disabled}
      error={useFieldError(path)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ViewQuery({
  form,
  draft,
}: {
  form: EditorForm;
  draft: CollectionDraft;
}) {
  const error = useFieldError("viewQuery");
  const schema = useSqlSchema();
  const collections = useCollections();
  const completions = useMemo(
    () => viewCompletions(collections.data ?? []),
    [collections.data],
  );
  return (
    <div className="flex flex-col gap-3">
      <form.Field name="viewQuery">
        {(field) => (
          <CodeArea
            label="Select query"
            language="sql"
            sqlSchema={schema}
            completions={completions}
            rows={8}
            value={field.state.value ?? ""}
            error={error}
            onChange={field.handleChange}
          />
        )}
      </form.Field>
      {draft.fields.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Fields from the saved query</p>
          <ul aria-label="View fields" className="flex flex-wrap gap-2">
            {draft.fields.map((f) => (
              <li
                key={f._key}
                className="rounded bg-hover px-2 py-0.5 font-mono text-xs"
              >
                {f.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FieldsTab({
  form,
  draft,
  clearError,
  onIndexes,
}: {
  form: EditorForm;
  draft: CollectionDraft;
  clearError: () => void;
  onIndexes: (indexes: string[]) => void;
}) {
  const [newType, setNewType] = useState<FieldType>("text");
  const keys = useStore(form.store, (s) => s.values.fields.map((f) => f._key));
  const removed = useStore(form.store, (s) =>
    s.values.fields.map((f) => !!f._removed),
  );
  let active = 0;
  const activeIndex = removed.map((r) => (r ? -1 : active++));

  const remove = (i: number) => {
    const field = form.getFieldValue(`fields[${i}]`);
    if (field.system) return;
    clearError();
    if (field.id) form.setFieldValue(`fields[${i}]._removed`, true);
    else form.removeFieldValue("fields", i);
  };

  return (
    <div className="flex flex-col gap-3">
      {keys.map((key, i) => (
        <form.Field key={key} name={`fields[${i}]`}>
          {(row) => (
            <FieldRow
              field={row.state.value}
              errorPath={`fields.${removed[i] ? -1 : activeIndex[i]}`}
              canMoveUp={i > 0}
              canMoveDown={i < keys.length - 1}
              onChange={(patch) =>
                row.handleChange((f) => ({ ...f, ...patch }))
              }
              onMove={(by) => {
                clearError();
                form.moveFieldValues("fields", i, i + by);
              }}
              onRemove={() => remove(i)}
              onRestore={() => {
                clearError();
                form.setFieldValue(`fields[${i}]._removed`, false);
              }}
            />
          )}
        </form.Field>
      ))}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            label="New field type"
            value={newType}
            onChange={(e) => setNewType(e.target.value as FieldType)}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <Button
          onClick={() => {
            clearError();
            form.pushFieldValue(
              "fields",
              newField(form.state.values.fields, newType),
            );
          }}
        >
          Add field
        </Button>
      </div>
      <IndexesEditor draft={draft} onChange={onIndexes} />
    </div>
  );
}
