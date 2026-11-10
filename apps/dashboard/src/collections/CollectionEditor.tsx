import type { CollectionModel } from "@heybe/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState, type FormEvent } from "react";
import { useClient } from "../app/context";
import {
  ErrorScope,
  UnclaimedErrors,
  errorMessage,
  useFieldError,
} from "../app/errors";
import { keys } from "../app/queries";
import { Button } from "../ui/Button";
import { CodeArea } from "../ui/CodeArea";
import { useConfirm } from "../ui/Confirm";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { Tabs } from "../ui/Tabs";
import { TextField } from "../ui/TextField";
import { useToast } from "../ui/Toasts";
import { ChangesDialog } from "./ChangesDialog";
import {
  addField,
  diffCollection,
  duplicateDraft,
  draftFrom,
  hasChanges,
  moveField,
  newDraft,
  removeField,
  renameCollection,
  renameField,
  restoreField,
  toPayload,
  type Changes,
  type CollectionDraft,
  type CollectionType,
  type FieldType,
} from "./editor-state";
import { FIELD_TYPES } from "./field-types";
import { FieldRow } from "./fields/FieldRow";

type Update = (fn: (d: CollectionDraft) => CollectionDraft) => void;

const same = (a: CollectionDraft | null, b: CollectionDraft | null) =>
  JSON.stringify(a && toPayload(a)) === JSON.stringify(b && toPayload(b));

export function CollectionEditor({
  collection,
  onClose,
}: {
  collection?: CollectionModel;
  onClose: () => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const formId = useId();
  const [source, setSource] = useState(collection);
  const [initial, setInitial] = useState(() =>
    collection ? draftFrom(collection) : null,
  );
  const [draft, setDraft] = useState(initial);
  const [tab, setTab] = useState("fields");
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Changes | null>(null);

  const scaffolds = useQuery({
    queryKey: ["collectionScaffolds"],
    queryFn: ({ signal }) => client.collections.scaffolds({ signal }),
    enabled: !source,
  });

  const start = (d: CollectionDraft) => {
    setInitial(d);
    setDraft(d);
    setError(null);
  };

  useEffect(() => {
    if (!draft && scaffolds.data) start(newDraft("base", scaffolds.data));
  }, [draft, scaffolds.data]);

  const update: Update = (fn) => setDraft((d) => d && fn(d));
  const dirty = !same(draft, initial);

  const confirmDiscard = async () =>
    !dirty ||
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
    if (!scaffolds.data || !draft) return;
    const next = renameCollection(newDraft(type, scaffolds.data), draft.name);
    if (type !== "view") {
      const scaffolded = scaffolds.data[draft.type]!.indexes;
      next.fields = [...next.fields, ...draft.fields.filter((f) => !f.system)];
      next.indexes = [
        ...next.indexes,
        ...draft.indexes.filter((sql) => !scaffolded.includes(sql)),
      ];
    }
    setDraft(next);
  };

  const submit = async () => {
    if (!draft) return;
    setPending(null);
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(draft);
      const saved = source
        ? await client.collections.update(source.id, payload)
        : await client.collections.create(payload);
      await queryClient.invalidateQueries({ queryKey: keys.collections });
      toast.success(source ? "Collection saved." : "Collection created.");
      onClose();
      if (!source)
        void navigate({
          to: "/collections/$collectionId",
          params: { collectionId: saved.id },
        });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (source) {
      const changes = diffCollection(source, draft);
      if (hasChanges(changes)) return setPending(changes);
    }
    void submit();
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
    { value: "fields", label: draft?.type === "view" ? "Query" : "Fields" },
  ];

  return (
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
                  <Button variant="danger" onClick={() => void truncate()}>
                    Truncate
                  </Button>
                )}
                {!system && (
                  <Button variant="danger" onClick={() => void remove()}>
                    Delete
                  </Button>
                )}
              </div>
            )}
            <Button onClick={() => void requestClose()}>Cancel</Button>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              loading={saving}
              disabled={!draft}
            >
              {source ? "Save changes" : "Create"}
            </Button>
          </>
        }
      >
        {draft ? (
          <form id={formId} onSubmit={save} className="flex flex-col gap-4">
            <UnclaimedErrors />
            <div className="flex gap-3">
              <div className="flex-1">
                <ScopedTextField
                  label="Name"
                  path="name"
                  value={draft.name}
                  disabled={system}
                  onChange={(name) => update((d) => renameCollection(d, name))}
                />
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
                <ViewQuery draft={draft} update={update} />
              ) : (
                <FieldsTab
                  draft={draft}
                  update={update}
                  reshape={(fn) => {
                    setError(null);
                    update(fn);
                  }}
                />
              ))}
          </form>
        ) : (
          <p className="text-sm">Loading…</p>
        )}
      </Dialog>
      {pending && (
        <ChangesDialog
          changes={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => void submit()}
        />
      )}
    </ErrorScope>
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
  draft,
  update,
}: {
  draft: CollectionDraft;
  update: Update;
}) {
  return (
    <CodeArea
      label="Select query"
      value={String(draft.viewQuery ?? "")}
      error={useFieldError("viewQuery")}
      onChange={(viewQuery) => update((d) => ({ ...d, viewQuery }))}
    />
  );
}

function FieldsTab({
  draft,
  update,
  reshape,
}: {
  draft: CollectionDraft;
  update: Update;
  reshape: Update;
}) {
  const [newType, setNewType] = useState<FieldType>("text");
  let index = 0;
  const last = draft.fields.length - 1;
  return (
    <div className="flex flex-col gap-3">
      {draft.fields.map((field, i) => (
        <FieldRow
          key={field._key}
          field={field}
          errorPath={`fields.${field._removed ? -1 : index++}`}
          canMoveUp={i > 0}
          canMoveDown={i < last}
          onChange={(patch) =>
            update((d) => ({
              ...d,
              fields: d.fields.map((f) =>
                f._key === field._key ? { ...f, ...patch } : f,
              ),
            }))
          }
          onRename={(name) => update((d) => renameField(d, field._key, name))}
          onMove={(by) => reshape((d) => moveField(d, field._key, by))}
          onRemove={() => reshape((d) => removeField(d, field._key))}
          onRestore={() => reshape((d) => restoreField(d, field._key))}
        />
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
        <Button onClick={() => reshape((d) => addField(d, newType))}>
          Add field
        </Button>
      </div>
    </div>
  );
}
