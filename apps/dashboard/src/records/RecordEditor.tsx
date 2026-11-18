import type { CollectionModel, WriteData } from "@heybe/client";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors, errorMessage } from "../app/errors";
import { signOut } from "../auth/session";
import { MoreHorizontal } from "lucide-react";
import {
  Button,
  Dialog,
  Menu,
  useConfirm,
  useToast,
  type MenuItem,
} from "@heybe/ui";
import { formatDate } from "../app/format";
import { useAuthActions } from "./AuthActions";
import type { CellField } from "./cell";
import { FieldInput, hasInput } from "./inputs/FieldInput";
import { PasswordInputs } from "./inputs/PasswordInputs";
import {
  JsonInputError,
  fieldsOf,
  expandOf,
  initialValues,
  toWriteData,
  type FormValues,
} from "./record-form";

type Rec = Record<string, unknown> & { id: string };

const DUPLICATE_SKIPPED = ["autodate", "file", "password"];

export function duplicateOf(c: CollectionModel, record: Rec): Rec {
  const copy: Rec = { ...record, id: "" };
  for (const f of fieldsOf(c))
    if (DUPLICATE_SKIPPED.includes(f.type)) delete copy[f.name];
  return copy;
}

export function RecordEditor({
  collection,
  recordId,
  prefill,
  onClose,
  onDuplicate,
}: {
  collection: CollectionModel;
  recordId: string;
  prefill?: Rec;
  onClose: () => void;
  onDuplicate: (record: Rec) => void;
}) {
  const client = useClient();
  const isNew = recordId === "new";
  const records = client.records(collection.name);
  const loaded = useQuery({
    queryKey: ["records", collection.id, { id: recordId }],
    queryFn: ({ signal }) =>
      records.findOne(recordId, { expand: expandOf(collection) }, { signal }),
    enabled: !isNew,
  });
  const readOnly = collection.type === "view";
  const title = isNew ? "New record" : readOnly ? "Record" : "Edit record";

  let body = null;
  if (!isNew && loaded.isError)
    body = <p role="alert">{errorMessage(loaded.error)}</p>;
  else if (!isNew && !loaded.data) body = <p>Loading...</p>;

  if (body)
    return (
      <Dialog open variant="side" title={title} onClose={onClose}>
        {body}
      </Dialog>
    );

  return (
    <EditorForm
      collection={collection}
      title={title}
      isNew={isNew}
      readOnly={readOnly}
      record={isNew ? prefill : (loaded.data as Rec)}
      onClose={onClose}
      onDuplicate={onDuplicate}
    />
  );
}

function EditorForm({
  collection,
  title,
  isNew,
  readOnly,
  record,
  onClose,
  onDuplicate,
}: {
  collection: CollectionModel;
  title: string;
  isNew: boolean;
  readOnly: boolean;
  record?: Rec;
  onClose: () => void;
  onDuplicate: (record: Rec) => void;
}) {
  const client = useClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const formId = useId();
  const initial = initialValues(collection, record);
  const [error, setError] = useState<unknown>(null);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const isAuth = collection.type === "auth";
  const records = client.records(collection.name);
  const isSelf =
    collection.name === "_superusers" &&
    !!record &&
    record.id === client.authStore.record?.id;

  const endOwnSession = () => {
    signOut({ client, queryClient });
    void navigate({ to: "/login" });
  };

  const save = async (values: FormValues) => {
    let data: WriteData<Record<string, unknown>>;
    try {
      data = toWriteData(
        collection,
        values,
        isNew ? undefined : record,
      ) as WriteData<Record<string, unknown>>;
    } catch (err) {
      if (!(err instanceof JsonInputError)) throw err;
      setError(null);
      setLocalErrors({ [err.field]: "Invalid JSON." });
      return;
    }
    setLocalErrors({});
    setError(null);
    try {
      if (isNew) await records.create(data);
      else await records.update(record!.id, data);
      if (isSelf && values.password) {
        toast.success("Record saved.");
        endOwnSession();
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["records", collection.id],
      });
      toast.success("Record saved.");
      onClose();
    } catch (err) {
      setError(err);
    }
  };

  const authActions = useAuthActions(collection, record ?? { id: "" });

  useEffect(() => {
    if (!error && Object.keys(localErrors).length === 0) return;
    const invalid = document
      .getElementById(formId)
      ?.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = invalid?.matches("input, select, textarea, button")
      ? invalid
      : invalid?.querySelector<HTMLElement>("input, select, textarea, button");
    target?.focus();
  }, [error, localErrors, formId]);

  const form = useForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  const confirmDiscard = async () =>
    JSON.stringify(form.state.values) === JSON.stringify(initial) ||
    (await confirm({
      title: "Discard unsaved changes?",
      message: "Your edits to this record will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      danger: true,
    }));

  const requestClose = async () => {
    if (await confirmDiscard()) onClose();
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete record",
      message: `Delete record ${record!.id}? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await records.delete(record!.id);
      if (isSelf) {
        toast.success("Record deleted.");
        endOwnSession();
        return;
      }
      await queryClient.invalidateQueries({
        queryKey: ["records", collection.id],
      });
      toast.success("Record deleted.");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const fields = fieldsOf(collection).filter((f: CellField) =>
    f.type === "password"
      ? !readOnly
      : !f.hidden &&
        f.type !== "autodate" &&
        hasInput(f) &&
        (isNew || f.name !== "id"),
  );
  const actions: MenuItem[] = [];
  if (record && !isNew) {
    if (!readOnly) actions.push({ key: "duplicate", label: "Duplicate" });
    actions.push({ key: "copy", label: "Copy JSON" });
    if (isAuth) actions.push(...authActions.items);
    if (!readOnly)
      actions.push(
        { separator: true },
        { key: "delete", label: "Delete", danger: true },
      );
  }
  const runAction = (key: string) => {
    if (key === "duplicate")
      void confirmDiscard().then(
        (ok) => ok && onDuplicate(duplicateOf(collection, record!)),
      );
    else if (key === "copy")
      navigator.clipboard.writeText(JSON.stringify(record, null, 2)).then(
        () => toast.success("Copied."),
        () => toast.error("Could not copy."),
      );
    else if (key === "delete") void remove();
    else authActions.run(key);
  };
  const meta = isNew
    ? []
    : fieldsOf(collection).filter(
        (f: CellField) =>
          f.type === "autodate" && !f.hidden && record?.[f.name],
      );

  return (
    <ErrorScope error={error}>
      <Dialog
        open
        variant="side"
        title={title}
        onClose={() => void requestClose()}
        footer={
          <>
            {record && !isNew && (
              <div className="mr-auto">
                <Menu
                  trigger={
                    <Button icon={<MoreHorizontal size={15} aria-hidden />}>
                      More actions
                    </Button>
                  }
                  placement="top-start"
                  items={actions}
                  onAction={runAction}
                />
              </div>
            )}
            <Button onClick={() => void requestClose()}>
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <form.Subscribe selector={(s) => s.isSubmitting}>
                {(isSubmitting) => (
                  <Button
                    type="submit"
                    form={formId}
                    variant="primary"
                    loading={isSubmitting}
                  >
                    {isNew ? "Create" : "Save changes"}
                  </Button>
                )}
              </form.Subscribe>
            )}
          </>
        }
      >
        <form
          id={formId}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void form.handleSubmit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-4">
            {fields.map((f) =>
              f.type === "password" ? (
                isAuth && (
                  <form.Subscribe
                    key={f.name}
                    selector={(s) => [
                      s.values.password,
                      s.values.passwordConfirm,
                    ]}
                  >
                    {([password, passwordConfirm]) => (
                      <PasswordInputs
                        isNew={isNew}
                        password={password as string}
                        confirm={passwordConfirm as string}
                        onChange={(password, passwordConfirm) => {
                          form.setFieldValue("password", password);
                          form.setFieldValue(
                            "passwordConfirm",
                            passwordConfirm,
                          );
                        }}
                      />
                    )}
                  </form.Subscribe>
                )
              ) : (
                <form.Field key={f.name} name={f.name}>
                  {(field) => (
                    <FieldInput
                      field={f}
                      value={field.state.value}
                      record={record}
                      disabled={readOnly}
                      localError={localErrors[f.name]}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
              ),
            )}
          </div>
          {!isNew && (
            <dl className="flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
              <div className="flex gap-2">
                <dt>id</dt>
                <dd className="font-mono">{record!.id}</dd>
              </div>
              {meta.map((f) => (
                <div key={f.name} className="flex gap-2">
                  <dt>{f.name}</dt>
                  <dd>{formatDate(String(record![f.name]))}</dd>
                </div>
              ))}
            </dl>
          )}
          <UnclaimedErrors />
        </form>
        {authActions.dialog}
      </Dialog>
    </ErrorScope>
  );
}
