import { afterEach, beforeEach, expect, test } from "bun:test";
import { type App, createApp } from "../app";
import type { Collection } from "../collections/model";
import { RecordModel } from "../records/model";
import {
  BootstrapEvent,
  CollectionEvent,
  ModelEvent,
  RecordEvent,
} from "./events";
import { HOOK_NAMES, TAGGED_HOOKS } from "./registry";

const NAMES =
  "onBootstrap onBootstrapClear onServe onTerminate onBackupCreate onBackupRestore onModelValidate onModelCreate onModelCreateExecute onModelAfterCreateSuccess onModelAfterCreateError onModelUpdate onModelUpdateExecute onModelAfterUpdateSuccess onModelAfterUpdateError onModelDelete onModelDeleteExecute onModelAfterDeleteSuccess onModelAfterDeleteError onRecordEnrich onRecordValidate onRecordCreate onRecordCreateExecute onRecordAfterCreateSuccess onRecordAfterCreateError onRecordUpdate onRecordUpdateExecute onRecordAfterUpdateSuccess onRecordAfterUpdateError onRecordDelete onRecordDeleteExecute onRecordAfterDeleteSuccess onRecordAfterDeleteError onCollectionValidate onCollectionCreate onCollectionCreateExecute onCollectionAfterCreateSuccess onCollectionAfterCreateError onCollectionUpdate onCollectionUpdateExecute onCollectionAfterUpdateSuccess onCollectionAfterUpdateError onCollectionDelete onCollectionDeleteExecute onCollectionAfterDeleteSuccess onCollectionAfterDeleteError onMailerSend onMailerRecordAuthAlertSend onMailerRecordPasswordResetSend onMailerRecordVerificationSend onMailerRecordEmailChangeSend onMailerRecordOTPSend onRealtimeConnectRequest onRealtimeMessageSend onRealtimeSubscribeRequest onSettingsListRequest onSettingsUpdateRequest onSettingsReload onFileDownloadRequest onFileTokenRequest onRecordAuthRequest onRecordAuthWithPasswordRequest onRecordAuthWithOAuth2Request onRecordAuthRefreshRequest onRecordRequestPasswordResetRequest onRecordConfirmPasswordResetRequest onRecordRequestVerificationRequest onRecordConfirmVerificationRequest onRecordRequestEmailChangeRequest onRecordConfirmEmailChangeRequest onRecordRequestOTPRequest onRecordAuthWithOTPRequest onRecordsListRequest onRecordViewRequest onRecordCreateRequest onRecordUpdateRequest onRecordDeleteRequest onCollectionsListRequest onCollectionViewRequest onCollectionCreateRequest onCollectionUpdateRequest onCollectionDeleteRequest onCollectionsImportRequest onBatchRequest".split(
    " ",
  );

let app: App;

beforeEach(() => {
  app = createApp({ dir: "" });
});

afterEach(() => app.close());

const collection = (name: string) =>
  ({ id: "pbc_" + name, name, fields: [] }) as unknown as Collection;

const recordEvent = (name: string) =>
  RecordEvent.of({
    app,
    record: new RecordModel(collection(name)),
    type: "create",
  });

test("registry has one hook per PB v0.41.1 core/app.go hook", () => {
  expect(NAMES).toHaveLength(84);
  expect(HOOK_NAMES).toEqual(NAMES as typeof HOOK_NAMES);
  expect(Object.keys(app.hooks)).toEqual(NAMES);
  for (const name of NAMES) expect(typeof (app as any)[name]).toBe("function");
});

test("tagged hooks match PB TaggedHook declarations", () => {
  const tagged = NAMES.filter(
    (n) =>
      /^on(Model|Record|MailerRecord|File)/.test(n) ||
      (/^onCollection[A-Z]/.test(n) && !n.endsWith("Request")),
  );
  expect([...TAGGED_HOOKS]).toEqual(tagged as typeof HOOK_NAMES);
  expect(TAGGED_HOOKS.has("onCollectionCreateRequest")).toBe(false);
  expect(TAGGED_HOOKS.has("onRecordCreateRequest")).toBe(true);
});

test("app binder with tags fires only for matching collections and unbinds by id", async () => {
  const seen: string[] = [];
  const id = app.onRecordCreate("posts", (e) => {
    seen.push(e.record.collection.name);
    return e.next();
  });
  app.onRecordCreate(["comments", "other"], (e) => {
    seen.push("tagged:" + e.record.collection.name);
    return e.next();
  });
  app.onRecordCreate((e) => {
    seen.push("all");
    return e.next();
  });

  await app.hooks.onRecordCreate.trigger(recordEvent("posts"));
  await app.hooks.onRecordCreate.trigger(recordEvent("comments"));
  expect(seen).toEqual(["posts", "all", "tagged:comments", "all"]);

  app.hooks.onRecordCreate.unbind(id);
  seen.length = 0;
  await app.hooks.onRecordCreate.trigger(recordEvent("posts"));
  expect(seen).toEqual(["all"]);
});

test("binder options keep id and priority", async () => {
  const calls: string[] = [];
  app.onBootstrap((e) => (calls.push("a"), e.next()));
  const id = app.onBootstrap((e) => (calls.push("b"), e.next()), {
    id: "first",
    priority: -1,
  });
  expect(id).toBe("first");
  await app.hooks.onBootstrap.trigger(BootstrapEvent.of({ app }));
  expect(calls).toEqual(["b", "a"]);
});

test("event tags follow PB", () => {
  const c = collection("posts");
  expect(recordEvent("posts").tags()).toEqual(["posts", "pbc_posts"]);
  expect(
    CollectionEvent.of({ app, collection: c, type: "create" }).tags(),
  ).toEqual(["pbc_posts", "posts"]);
  expect(
    ModelEvent.of({ app, model: new RecordModel(c), type: "create" }).tags(),
  ).toEqual(["posts", "pbc_posts"]);
  expect(ModelEvent.of({ app, model: c, type: "create" }).tags()).toEqual([
    "_collections",
  ]);
});
