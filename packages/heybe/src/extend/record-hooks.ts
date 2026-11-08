import type { App } from "../app";
import type { Hook, HookEvent } from "../hooks/hook";
import type { HookEvents } from "../hooks/registry";

const HOOKS = {
  onValidate: "onRecordValidate",
  onCreate: "onRecordCreate",
  onCreateExecute: "onRecordCreateExecute",
  onAfterCreateSuccess: "onRecordAfterCreateSuccess",
  onAfterCreateError: "onRecordAfterCreateError",
  onUpdate: "onRecordUpdate",
  onUpdateExecute: "onRecordUpdateExecute",
  onAfterUpdateSuccess: "onRecordAfterUpdateSuccess",
  onAfterUpdateError: "onRecordAfterUpdateError",
  onDelete: "onRecordDelete",
  onDeleteExecute: "onRecordDeleteExecute",
  onAfterDeleteSuccess: "onRecordAfterDeleteSuccess",
  onAfterDeleteError: "onRecordAfterDeleteError",
  onEnrich: "onRecordEnrich",
  onListRequest: "onRecordsListRequest",
  onViewRequest: "onRecordViewRequest",
  onCreateRequest: "onRecordCreateRequest",
  onUpdateRequest: "onRecordUpdateRequest",
  onDeleteRequest: "onRecordDeleteRequest",
  onAuthRequest: "onRecordAuthRequest",
  onAuthWithPasswordRequest: "onRecordAuthWithPasswordRequest",
  onAuthWithOAuth2Request: "onRecordAuthWithOAuth2Request",
  onAuthRefreshRequest: "onRecordAuthRefreshRequest",
  onRequestPasswordResetRequest: "onRecordRequestPasswordResetRequest",
  onConfirmPasswordResetRequest: "onRecordConfirmPasswordResetRequest",
  onRequestVerificationRequest: "onRecordRequestVerificationRequest",
  onConfirmVerificationRequest: "onRecordConfirmVerificationRequest",
  onRequestEmailChangeRequest: "onRecordRequestEmailChangeRequest",
  onConfirmEmailChangeRequest: "onRecordConfirmEmailChangeRequest",
  onRequestOTPRequest: "onRecordRequestOTPRequest",
  onAuthWithOTPRequest: "onRecordAuthWithOTPRequest",
} as const satisfies Record<string, keyof HookEvents>;

// Class style for the record hooks of one collection: `app.register(MyHooks)`. Each defined
// handler binds to its `app.onRecord*` hook with the collection as the tag.
export abstract class RecordHooks {
  abstract collection: string;
  priority?: number;
}

// methods, so subclasses can define them as methods
export interface RecordHooks {
  onValidate?(e: HookEvents["onRecordValidate"]): unknown;
  onCreate?(e: HookEvents["onRecordCreate"]): unknown;
  onCreateExecute?(e: HookEvents["onRecordCreateExecute"]): unknown;
  onAfterCreateSuccess?(e: HookEvents["onRecordAfterCreateSuccess"]): unknown;
  onAfterCreateError?(e: HookEvents["onRecordAfterCreateError"]): unknown;
  onUpdate?(e: HookEvents["onRecordUpdate"]): unknown;
  onUpdateExecute?(e: HookEvents["onRecordUpdateExecute"]): unknown;
  onAfterUpdateSuccess?(e: HookEvents["onRecordAfterUpdateSuccess"]): unknown;
  onAfterUpdateError?(e: HookEvents["onRecordAfterUpdateError"]): unknown;
  onDelete?(e: HookEvents["onRecordDelete"]): unknown;
  onDeleteExecute?(e: HookEvents["onRecordDeleteExecute"]): unknown;
  onAfterDeleteSuccess?(e: HookEvents["onRecordAfterDeleteSuccess"]): unknown;
  onAfterDeleteError?(e: HookEvents["onRecordAfterDeleteError"]): unknown;
  onEnrich?(e: HookEvents["onRecordEnrich"]): unknown;
  onListRequest?(e: HookEvents["onRecordsListRequest"]): unknown;
  onViewRequest?(e: HookEvents["onRecordViewRequest"]): unknown;
  onCreateRequest?(e: HookEvents["onRecordCreateRequest"]): unknown;
  onUpdateRequest?(e: HookEvents["onRecordUpdateRequest"]): unknown;
  onDeleteRequest?(e: HookEvents["onRecordDeleteRequest"]): unknown;
  onAuthRequest?(e: HookEvents["onRecordAuthRequest"]): unknown;
  onAuthWithPasswordRequest?(
    e: HookEvents["onRecordAuthWithPasswordRequest"],
  ): unknown;
  onAuthWithOAuth2Request?(
    e: HookEvents["onRecordAuthWithOAuth2Request"],
  ): unknown;
  onAuthRefreshRequest?(e: HookEvents["onRecordAuthRefreshRequest"]): unknown;
  onRequestPasswordResetRequest?(
    e: HookEvents["onRecordRequestPasswordResetRequest"],
  ): unknown;
  onConfirmPasswordResetRequest?(
    e: HookEvents["onRecordConfirmPasswordResetRequest"],
  ): unknown;
  onRequestVerificationRequest?(
    e: HookEvents["onRecordRequestVerificationRequest"],
  ): unknown;
  onConfirmVerificationRequest?(
    e: HookEvents["onRecordConfirmVerificationRequest"],
  ): unknown;
  onRequestEmailChangeRequest?(
    e: HookEvents["onRecordRequestEmailChangeRequest"],
  ): unknown;
  onConfirmEmailChangeRequest?(
    e: HookEvents["onRecordConfirmEmailChangeRequest"],
  ): unknown;
  onRequestOTPRequest?(e: HookEvents["onRecordRequestOTPRequest"]): unknown;
  onAuthWithOTPRequest?(e: HookEvents["onRecordAuthWithOTPRequest"]): unknown;
}

export function bindRecordHooks(app: App, hooks: RecordHooks): void {
  for (const [method, name] of Object.entries(HOOKS)) {
    const fn = hooks[method as keyof typeof HOOKS] as
      ((e: HookEvent) => unknown) | undefined;
    if (!fn) continue;
    (app.hooks[name] as unknown as Hook<HookEvent>).bind(
      (e) => fn.call(hooks, e),
      {
        priority: hooks.priority,
        tags: [hooks.collection],
      },
    );
  }
}
