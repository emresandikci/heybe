import type { App } from "../app";
import type { PasswordValue } from "../fields";
import { RecordModel } from "../records/model";
import { RecordServiceImpl } from "../records/service";
import { INSTALLER_EMAIL } from "../util";
import {
  CollectionErrorEvent,
  CollectionEvent,
  type Model,
  ModelErrorEvent,
  ModelEvent,
  RecordErrorEvent,
  RecordEvent,
} from "./events";
import type { Hook, HookEvent } from "./hook";

// PB core/db.go, core/record_model.go, core/collection_model.go and core/auth_origin_model.go

export const RECORD_SYSTEM_HOOK_ID = "__pbRecordSystemHook__";
export const COLLECTION_SYSTEM_HOOK_ID = "__pbCollectionSystemHook__";

type Op = "Create" | "Update" | "Delete";

const STAGES = (["Create", "Update", "Delete"] as const).flatMap((op) => [
  op,
  `${op}Execute`,
  `After${op}Success`,
  `After${op}Error`,
]);

const hook = (app: App, name: string) =>
  (app.hooks as unknown as Record<string, Hook<HookEvent>>)[name]!;

const records = (app: App, name: string) => new RecordServiceImpl(app, name);

async function runModel(
  app: App,
  model: Model,
  op: Op,
  action: (e: ModelEvent) => Promise<void>,
): Promise<void> {
  const event = ModelEvent.of({ app, model, type: op.toLowerCase() as never });
  const errorEvent = (error: unknown, eventApp: App) =>
    ModelErrorEvent.of({
      app: eventApp,
      model: event.model,
      type: event.type,
      error: error as Error,
    });
  // PB MarkAsNew: a create that failed or rolled back leaves the record new again
  const resetNew = () => {
    if (op === "Create" && event.model instanceof RecordModel)
      event.model.markAsNew();
  };
  try {
    await hook(app, `onModel${op}`).trigger(event, (e) =>
      action(e as ModelEvent),
    );
  } catch (err) {
    resetNew();
    try {
      await hook(app, `onModelAfter${op}Error`).trigger(errorEvent(err, app));
    } catch (hookErr) {
      throw new AggregateError([err, hookErr], `${err}; ${hookErr}`);
    }
    throw err;
  }
  // PB txInfo.OnComplete: right away outside a transaction, else once it ends
  let now: unknown;
  app.db.onComplete(
    (txErr) =>
      (now =
        txErr === null
          ? hook(app, `onModelAfter${op}Success`).trigger(event)
          : (resetNew(),
            hook(app, `onModelAfter${op}Error`).trigger(
              errorEvent(txErr, event.app),
            ))),
  );
  await now;
}

export function validateModel(app: App, model: Model): Promise<void> {
  return hook(app, "onModelValidate").trigger(
    ModelEvent.of({ app, model, type: "validate" }),
  );
}

// `execute` is the db write; validation runs unless `validate` is false (PB SaveNoValidate)
export function saveModel(
  app: App,
  model: Model,
  isNew: boolean,
  validate: boolean,
  execute: () => Promise<void>,
): Promise<void> {
  const op = isNew ? "Create" : "Update";
  return runModel(app, model, op, async (e) => {
    if (validate) await validateModel(e.app, e.model);
    await hook(e.app, `onModel${op}Execute`).trigger(e, execute);
  });
}

export function deleteModel(
  app: App,
  model: Model,
  execute: () => Promise<void>,
): Promise<void> {
  return runModel(app, model, "Delete", (e) =>
    hook(e.app, "onModelDeleteExecute").trigger(e, execute),
  );
}

type Target = RecordEvent | CollectionEvent;

// PB newRecordEventFromModelEvent and the sync helpers: a new event per model event, synced both ways
function bindBridge(app: App, kind: "Record" | "Collection") {
  const key = kind === "Record" ? "record" : "collection";
  const isError = (stage: string) => stage.endsWith("Error");
  const make = (stage: string): Target =>
    kind === "Record"
      ? new (isError(stage) ? RecordErrorEvent : RecordEvent)()
      : new (isError(stage) ? CollectionErrorEvent : CollectionEvent)();
  const toModel = (me: ModelEvent, te: Target, error: boolean) => {
    me.app = te.app;
    me.type = te.type;
    me.model = (te as unknown as Record<string, Model>)[key]!;
    if (error) (me as ModelErrorEvent).error = (te as RecordErrorEvent).error;
  };
  const toTarget = (te: Target, me: ModelEvent, error: boolean) => {
    te.app = me.app;
    te.type = me.type;
    (te as unknown as Record<string, Model>)[key] = me.model;
    if (error) (te as RecordErrorEvent).error = (me as ModelErrorEvent).error;
  };
  for (const stage of ["Validate", ...STAGES]) {
    const error = isError(stage);
    hook(app, `onModel${stage}`).bind(
      async (e) => {
        const me = e as ModelEvent;
        if (me.model instanceof RecordModel !== (kind === "Record"))
          return me.next();
        const te = make(stage);
        toTarget(te, me, error);
        try {
          await hook(me.app, `on${kind}${stage}`).trigger(te, async () => {
            toModel(me, te, error);
            try {
              await me.next();
            } finally {
              toTarget(te, me, error);
            }
          });
        } finally {
          toModel(me, te, error);
        }
      },
      {
        id:
          kind === "Record" ? RECORD_SYSTEM_HOOK_ID : COLLECTION_SYSTEM_HOOK_ID,
        priority: -99,
      },
    );
  }
}

function bindCollectionHooks(app: App) {
  const opts = { id: COLLECTION_SYSTEM_HOOK_ID, priority: 99 };
  app.hooks.onCollectionValidate.bind((e) => {
    e.app.collections.validateSave(e.collection);
    return e.next();
  }, opts);
  for (const name of [
    "onCollectionCreateExecute",
    "onCollectionUpdateExecute",
  ] as const)
    app.hooks[name].bind(
      (e) => e.app.collections.executeSave(e.collection, () => e.next()),
      opts,
    );
  app.hooks.onCollectionDeleteExecute.bind(
    (e) => e.app.collections.executeDelete(e.collection, () => e.next()),
    opts,
  );
}

function bindRecordHooks(app: App) {
  const opts = { id: RECORD_SYSTEM_HOOK_ID };
  const service = (e: RecordEvent) => records(e.app, e.record.collection.name);
  app.hooks.onRecordValidate.bind((e) => service(e).validateHook(e), {
    ...opts,
    priority: 99,
  });
  app.hooks.onRecordCreate.bind((e) => service(e).autogenerateHook(e), {
    ...opts,
    priority: -99,
  });
  for (const name of [
    "onRecordCreateExecute",
    "onRecordUpdateExecute",
  ] as const)
    app.hooks[name].bind((e) => service(e).saveExecuteHook(e), {
      ...opts,
      priority: 99,
    });
  app.hooks.onRecordDeleteExecute.bind((e) => service(e).deleteExecuteHook(e), {
    ...opts,
    priority: 99,
  });
}

// PB recordRefHooks: the rows that point to a deleted auth record or collection go with it
function bindRecordRefHooks(app: App, name: string) {
  app.hooks.onCollectionDeleteExecute.bind(
    (e) => {
      if (e.collection.name === name || e.collection.type !== "auth")
        return e.next();
      return e.app.db.write(async () => {
        await e.next();
        await records(e.app, name).deleteWhere("collectionRef = ?", [
          e.collection.id,
        ]);
      });
    },
    { priority: 99 },
  );
  app.hooks.onRecordDeleteExecute.bind(
    (e) => {
      const c = e.record.collection;
      if (c.name === name || c.type !== "auth") return e.next();
      return e.app.db.write(async () => {
        await e.next();
        await deleteByRecord(e, name);
      });
    },
    { priority: 99 },
  );
}

const isAuth = (e: RecordEvent) => e.record.collection.type === "auth";

const deleteByRecord = (e: RecordEvent, name: string) =>
  records(e.app, name).deleteWhere("collectionRef = ? AND recordRef = ?", [
    e.record.collection.id,
    e.record.id,
  ]);

const passwordHash = (record: RecordModel) =>
  (record.get("password") as PasswordValue | undefined)?.hash ?? "";

// PB registerSuperuserHooks
function bindSuperuserHooks(app: App) {
  for (const name of [
    "onRecordCreateExecute",
    "onRecordUpdateExecute",
  ] as const)
    app.hooks[name].bind(
      async (e) => {
        e.record.set("verified", true);
        await e.next();
        if (e.type !== "create" || e.record.get("email") === INSTALLER_EMAIL)
          return;
        try {
          await records(e.app, "_superusers").deleteWhere("email = ?", [
            INSTALLER_EMAIL,
          ]);
        } catch (error) {
          e.app.logger.warn("Failed to delete installer superuser", {
            error,
          });
        }
      },
      {
        id: "pbSuperusersRecordSaveExec",
        priority: -99,
        tags: ["_superusers"],
      },
    );
}

// PB registerExternalAuthHooks: a verified upgrade drops the record's OAuth2 links and refreshes
// its tokenKey, so links made to a pre-created unverified account stop working
function bindExternalAuthHooks(app: App) {
  bindRecordRefHooks(app, "_externalAuths");
  app.hooks.onRecordUpdateExecute.bind(
    (e) => {
      const upgraded =
        isAuth(e) &&
        e.record.original().get("verified") !== true &&
        e.record.get("verified") === true;
      if (!upgraded) return e.next();
      return e.app.db.write(async () => {
        const found = e.app.db.get(
          "SELECT 1 FROM _externalAuths WHERE collectionRef = ? AND recordRef = ?",
          [e.record.collection.id, e.record.id],
        );
        if (found) {
          await deleteByRecord(e, "_externalAuths");
          e.record.set("tokenKey:autogenerate", "");
        }
        await e.next();
      });
    },
    { priority: 99 },
  );
}

// PB registerMFAHooks and registerAuthOriginHooks: a password change drops the record's MFAs
// (failures returned) and auth origins (failures only logged)
function bindPasswordChangeHook(app: App, name: string, quiet: boolean) {
  bindRecordRefHooks(app, name);
  app.hooks.onRecordUpdate.bind(
    async (e) => {
      await e.next();
      if (
        !isAuth(e) ||
        passwordHash(e.record.original()) === passwordHash(e.record)
      )
        return;
      try {
        await deleteByRecord(e, name);
      } catch (err) {
        if (!quiet) throw err;
        e.app.logger.warn(`Failed to delete the previous ${name}`, {
          error: err,
        });
      }
    },
    { priority: 99 },
  );
}

// PB registerOTPHooks: a tokenKey change drops the record's OTPs
function bindOTPHooks(app: App) {
  bindRecordRefHooks(app, "_otps");
  app.hooks.onRecordUpdateExecute.bind(
    async (e) => {
      await e.next();
      if (
        isAuth(e) &&
        e.record.original().get("tokenKey") !== e.record.get("tokenKey")
      )
        await deleteByRecord(e, "_otps");
    },
    { priority: 99 },
  );
}

// PB core/base.go registerBaseHooks order
export function registerSystemHooks(app: App): void {
  bindBridge(app, "Collection");
  bindCollectionHooks(app);
  bindBridge(app, "Record");
  bindRecordHooks(app);
  bindSuperuserHooks(app);
  bindExternalAuthHooks(app);
  bindPasswordChangeHook(app, "_mfas", false);
  bindOTPHooks(app);
  bindPasswordChangeHook(app, "_authOrigins", true);
}
