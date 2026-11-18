import type { CollectionName } from "@heybe/query";
import type * as ev from "./events";
import { type BindOptions, Hook, type HookHandler } from "./hook";

export interface HookEvents {
  onBootstrap: ev.BootstrapEvent;
  onBootstrapClear: ev.BootstrapEvent;
  onServe: ev.ServeEvent;
  onTerminate: ev.TerminateEvent;
  onBackupCreate: ev.BackupEvent;
  onBackupRestore: ev.BackupEvent;
  onModelValidate: ev.ModelEvent;
  onModelCreate: ev.ModelEvent;
  onModelCreateExecute: ev.ModelEvent;
  onModelAfterCreateSuccess: ev.ModelEvent;
  onModelAfterCreateError: ev.ModelErrorEvent;
  onModelUpdate: ev.ModelEvent;
  onModelUpdateExecute: ev.ModelEvent;
  onModelAfterUpdateSuccess: ev.ModelEvent;
  onModelAfterUpdateError: ev.ModelErrorEvent;
  onModelDelete: ev.ModelEvent;
  onModelDeleteExecute: ev.ModelEvent;
  onModelAfterDeleteSuccess: ev.ModelEvent;
  onModelAfterDeleteError: ev.ModelErrorEvent;
  onRecordEnrich: ev.RecordEnrichEvent;
  onRecordValidate: ev.RecordEvent;
  onRecordCreate: ev.RecordEvent;
  onRecordCreateExecute: ev.RecordEvent;
  onRecordAfterCreateSuccess: ev.RecordEvent;
  onRecordAfterCreateError: ev.RecordErrorEvent;
  onRecordUpdate: ev.RecordEvent;
  onRecordUpdateExecute: ev.RecordEvent;
  onRecordAfterUpdateSuccess: ev.RecordEvent;
  onRecordAfterUpdateError: ev.RecordErrorEvent;
  onRecordDelete: ev.RecordEvent;
  onRecordDeleteExecute: ev.RecordEvent;
  onRecordAfterDeleteSuccess: ev.RecordEvent;
  onRecordAfterDeleteError: ev.RecordErrorEvent;
  onCollectionValidate: ev.CollectionEvent;
  onCollectionCreate: ev.CollectionEvent;
  onCollectionCreateExecute: ev.CollectionEvent;
  onCollectionAfterCreateSuccess: ev.CollectionEvent;
  onCollectionAfterCreateError: ev.CollectionErrorEvent;
  onCollectionUpdate: ev.CollectionEvent;
  onCollectionUpdateExecute: ev.CollectionEvent;
  onCollectionAfterUpdateSuccess: ev.CollectionEvent;
  onCollectionAfterUpdateError: ev.CollectionErrorEvent;
  onCollectionDelete: ev.CollectionEvent;
  onCollectionDeleteExecute: ev.CollectionEvent;
  onCollectionAfterDeleteSuccess: ev.CollectionEvent;
  onCollectionAfterDeleteError: ev.CollectionErrorEvent;
  onMailerSend: ev.MailerEvent;
  onMailerRecordAuthAlertSend: ev.MailerRecordEvent;
  onMailerRecordPasswordResetSend: ev.MailerRecordEvent;
  onMailerRecordVerificationSend: ev.MailerRecordEvent;
  onMailerRecordEmailChangeSend: ev.MailerRecordEvent;
  onMailerRecordOTPSend: ev.MailerRecordEvent;
  onRealtimeConnectRequest: ev.RealtimeConnectRequestEvent;
  onRealtimeMessageSend: ev.RealtimeMessageEvent;
  onRealtimeSubscribeRequest: ev.RealtimeSubscribeRequestEvent;
  onSettingsListRequest: ev.SettingsListRequestEvent;
  onSettingsUpdateRequest: ev.SettingsUpdateRequestEvent;
  onSettingsReload: ev.SettingsReloadEvent;
  onFileDownloadRequest: ev.FileDownloadRequestEvent;
  onFileTokenRequest: ev.FileTokenRequestEvent;
  onRecordAuthRequest: ev.RecordAuthRequestEvent;
  onRecordAuthWithPasswordRequest: ev.RecordAuthWithPasswordRequestEvent;
  onRecordAuthWithOAuth2Request: ev.RecordAuthWithOAuth2RequestEvent;
  onRecordAuthRefreshRequest: ev.RecordAuthRefreshRequestEvent;
  onRecordRequestPasswordResetRequest: ev.RecordRequestPasswordResetRequestEvent;
  onRecordConfirmPasswordResetRequest: ev.RecordConfirmPasswordResetRequestEvent;
  onRecordRequestVerificationRequest: ev.RecordRequestVerificationRequestEvent;
  onRecordConfirmVerificationRequest: ev.RecordConfirmVerificationRequestEvent;
  onRecordRequestEmailChangeRequest: ev.RecordRequestEmailChangeRequestEvent;
  onRecordConfirmEmailChangeRequest: ev.RecordConfirmEmailChangeRequestEvent;
  onRecordRequestOTPRequest: ev.RecordCreateOTPRequestEvent;
  onRecordAuthWithOTPRequest: ev.RecordAuthWithOTPRequestEvent;
  onRecordsListRequest: ev.RecordsListRequestEvent;
  onRecordViewRequest: ev.RecordRequestEvent;
  onRecordCreateRequest: ev.RecordRequestEvent;
  onRecordUpdateRequest: ev.RecordRequestEvent;
  onRecordDeleteRequest: ev.RecordRequestEvent;
  onCollectionsListRequest: ev.CollectionsListRequestEvent;
  onCollectionViewRequest: ev.CollectionRequestEvent;
  onCollectionCreateRequest: ev.CollectionRequestEvent;
  onCollectionUpdateRequest: ev.CollectionRequestEvent;
  onCollectionDeleteRequest: ev.CollectionRequestEvent;
  onCollectionsImportRequest: ev.CollectionsImportRequestEvent;
  onBatchRequest: ev.BatchRequestEvent;
}

// true marks a PB TaggedHook (core/app.go)
const TAGGED = {
  onBootstrap: false,
  onBootstrapClear: false,
  onServe: false,
  onTerminate: false,
  onBackupCreate: false,
  onBackupRestore: false,
  onModelValidate: true,
  onModelCreate: true,
  onModelCreateExecute: true,
  onModelAfterCreateSuccess: true,
  onModelAfterCreateError: true,
  onModelUpdate: true,
  onModelUpdateExecute: true,
  onModelAfterUpdateSuccess: true,
  onModelAfterUpdateError: true,
  onModelDelete: true,
  onModelDeleteExecute: true,
  onModelAfterDeleteSuccess: true,
  onModelAfterDeleteError: true,
  onRecordEnrich: true,
  onRecordValidate: true,
  onRecordCreate: true,
  onRecordCreateExecute: true,
  onRecordAfterCreateSuccess: true,
  onRecordAfterCreateError: true,
  onRecordUpdate: true,
  onRecordUpdateExecute: true,
  onRecordAfterUpdateSuccess: true,
  onRecordAfterUpdateError: true,
  onRecordDelete: true,
  onRecordDeleteExecute: true,
  onRecordAfterDeleteSuccess: true,
  onRecordAfterDeleteError: true,
  onCollectionValidate: true,
  onCollectionCreate: true,
  onCollectionCreateExecute: true,
  onCollectionAfterCreateSuccess: true,
  onCollectionAfterCreateError: true,
  onCollectionUpdate: true,
  onCollectionUpdateExecute: true,
  onCollectionAfterUpdateSuccess: true,
  onCollectionAfterUpdateError: true,
  onCollectionDelete: true,
  onCollectionDeleteExecute: true,
  onCollectionAfterDeleteSuccess: true,
  onCollectionAfterDeleteError: true,
  onMailerSend: false,
  onMailerRecordAuthAlertSend: true,
  onMailerRecordPasswordResetSend: true,
  onMailerRecordVerificationSend: true,
  onMailerRecordEmailChangeSend: true,
  onMailerRecordOTPSend: true,
  onRealtimeConnectRequest: false,
  onRealtimeMessageSend: false,
  onRealtimeSubscribeRequest: false,
  onSettingsListRequest: false,
  onSettingsUpdateRequest: false,
  onSettingsReload: false,
  onFileDownloadRequest: true,
  onFileTokenRequest: true,
  onRecordAuthRequest: true,
  onRecordAuthWithPasswordRequest: true,
  onRecordAuthWithOAuth2Request: true,
  onRecordAuthRefreshRequest: true,
  onRecordRequestPasswordResetRequest: true,
  onRecordConfirmPasswordResetRequest: true,
  onRecordRequestVerificationRequest: true,
  onRecordConfirmVerificationRequest: true,
  onRecordRequestEmailChangeRequest: true,
  onRecordConfirmEmailChangeRequest: true,
  onRecordRequestOTPRequest: true,
  onRecordAuthWithOTPRequest: true,
  onRecordsListRequest: true,
  onRecordViewRequest: true,
  onRecordCreateRequest: true,
  onRecordUpdateRequest: true,
  onRecordDeleteRequest: true,
  onCollectionsListRequest: false,
  onCollectionViewRequest: false,
  onCollectionCreateRequest: false,
  onCollectionUpdateRequest: false,
  onCollectionDeleteRequest: false,
  onCollectionsImportRequest: false,
  onBatchRequest: false,
} as const satisfies Record<keyof HookEvents, boolean>;

export type HookName = keyof HookEvents;

type TaggedName = {
  [K in HookName]: (typeof TAGGED)[K] extends true ? K : never;
}[HookName];

export const HOOK_NAMES = Object.keys(TAGGED) as HookName[];

export const TAGGED_HOOKS: ReadonlySet<HookName> = new Set(
  HOOK_NAMES.filter((k) => TAGGED[k]),
);

export type Hooks = { [K in HookName]: Hook<HookEvents[K]> };

export function createHooks(): Hooks {
  return Object.fromEntries(
    HOOK_NAMES.map((k) => [k, new Hook()]),
  ) as unknown as Hooks;
}

type BinderOptions = Omit<BindOptions, "tags">;

type Binder<T> = (fn: HookHandler<T>, opts?: BinderOptions) => string;

// a collection name or id; typegen's names are suggested
export type CollectionTag = CollectionName | (string & {});

interface TaggedBinder<T> {
  (fn: HookHandler<T>, opts?: BinderOptions): string;
  (
    tags: CollectionTag | CollectionTag[],
    fn: HookHandler<T>,
    opts?: BinderOptions,
  ): string;
}

/**
 * `app.on<Hook>(fn)` or, for tagged hooks, `app.on<Hook>(tags, fn)`. Notes for handlers that write:
 * - A write started inside a hook without being awaited joins the open transaction as a savepoint.
 *   Statements the caller runs while it is open run inside that savepoint and are lost if it rolls back.
 * - Such a late write is awaited before the transaction ends, so waiting there on something that is
 *   released only after the outer write returns deadlocks.
 * - `db.onComplete` callbacks (and the after-success hooks they run) are not called in strict
 *   registration order: those of a nested write follow the ones its parent registered while it ran.
 * - Await `e.next()`: a chain whose `next()` is not awaited ends before the action runs.
 */
export type HookBinders = {
  [K in HookName]: K extends TaggedName
    ? TaggedBinder<HookEvents[K]>
    : Binder<HookEvents[K]>;
};

export function hookBinders(hooks: Hooks): HookBinders {
  const bind = (
    hook: Hook<any>,
    a: string | string[] | HookHandler<any>,
    b?: HookHandler<any> | BindOptions,
    c?: BindOptions,
  ) =>
    typeof a === "function"
      ? hook.bind(a, b as BindOptions | undefined)
      : hook.bind(b as HookHandler<any>, { ...c, tags: [a].flat() });
  return Object.fromEntries(
    HOOK_NAMES.map((k) => [
      k,
      (a: any, b?: any, c?: BindOptions) => bind(hooks[k], a, b, c),
    ]),
  ) as unknown as HookBinders;
}
