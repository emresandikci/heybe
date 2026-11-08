import type { ListResult } from "@heybe/query";
import type { App } from "../app";
import type { AuthUser, Provider } from "../auth/oauth2/flow";
import type { Collection, Field } from "../collections/model";
import type { RequestInfo } from "../filter/compile";
import { RequestEvent, type Router } from "../http/router";
import type { MailMessage, Mailer } from "../mail/mailer";
import { RecordModel } from "../records/model";
import type { SettingsData } from "../settings";
import { HookEvent } from "./hook";

export type Model = RecordModel | Collection;

function recordTags(record: RecordModel | null): string[] {
  return record ? [record.collection.name, record.collection.id] : [];
}

function collectionTags(collection: Collection | null): string[] {
  if (!collection) return [];
  return [collection.id, collection.name].filter((t) => t !== "");
}

export class BootstrapEvent extends HookEvent {
  declare app: App;
}

export class TerminateEvent extends HookEvent {
  declare app: App;
  declare isRestart: boolean;
}

export class BackupEvent extends HookEvent {
  declare app: App;
  declare name: string;
  declare exclude: string[];
}

export class ServeEvent extends HookEvent {
  declare app: App;
  declare router: Router;
  declare server: Bun.Server<unknown> | null;
}

export class SettingsReloadEvent extends HookEvent {
  declare app: App;
}

export class MailerEvent extends HookEvent {
  declare app: App;
  declare mailer: Mailer;
  declare message: MailMessage;
}

export class MailerRecordEvent extends MailerEvent {
  declare record: RecordModel;
  declare meta: Record<string, unknown>;

  override tags(): string[] {
    return recordTags(this.record);
  }
}

export class ModelEvent extends HookEvent {
  declare app: App;
  declare model: Model;
  declare type: "create" | "update" | "delete" | "validate";

  override tags(): string[] {
    return this.model instanceof RecordModel
      ? recordTags(this.model)
      : ["_collections"];
  }
}

export class ModelErrorEvent extends ModelEvent {
  declare error: Error;
}

export class RecordEvent extends HookEvent {
  declare app: App;
  declare record: RecordModel;
  declare type: ModelEvent["type"];

  override tags(): string[] {
    return recordTags(this.record);
  }
}

export class RecordErrorEvent extends RecordEvent {
  declare error: Error;
}

export class CollectionEvent extends HookEvent {
  declare app: App;
  declare collection: Collection;
  declare type: ModelEvent["type"];

  override tags(): string[] {
    return collectionTags(this.collection);
  }
}

export class CollectionErrorEvent extends CollectionEvent {
  declare error: Error;
}

export class RecordEnrichEvent extends HookEvent {
  declare app: App;
  declare record: RecordModel;
  declare requestInfo: RequestInfo;

  override tags(): string[] {
    return recordTags(this.record);
  }
}

// Built with `RequestHookEvent.from(re, fields)`: shares auth, response, store and request info with
// the router event `re`, with its own `next` and `extra`.
export class RequestHookEvent extends RequestEvent {}

class CollectionScopedRequestEvent extends RequestHookEvent {
  declare collection: Collection;

  override tags(): string[] {
    return collectionTags(this.collection);
  }
}

export class SettingsListRequestEvent extends RequestHookEvent {
  declare settings: SettingsData;
}

export class SettingsUpdateRequestEvent extends RequestHookEvent {
  declare oldSettings: SettingsData;
  declare newSettings: SettingsData;
}

export class FileTokenRequestEvent extends RequestHookEvent {
  declare record: RecordModel | null;
  declare token: string;

  override tags(): string[] {
    return recordTags(this.record);
  }
}

export class FileDownloadRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
  declare fileField: Field;
  declare servedPath: string;
  declare servedName: string;
  declare thumbError: Error | null;
}

export class CollectionsListRequestEvent extends RequestHookEvent {
  declare collections: Collection[];
  declare result: ListResult<unknown>;
}

export class CollectionsImportRequestEvent extends RequestHookEvent {
  declare collectionsData: Record<string, unknown>[];
  declare deleteMissing: boolean;
}

export class CollectionRequestEvent extends CollectionScopedRequestEvent {}

// client and message get their types with the realtime broker (Task 9)
export class RealtimeConnectRequestEvent extends RequestHookEvent {
  declare client: unknown;
  declare idleTimeout: number;
  declare maxTimeout: number;
}

export class RealtimeMessageEvent extends RequestHookEvent {
  declare client: unknown;
  declare message: unknown;
}

export class RealtimeSubscribeRequestEvent extends RequestHookEvent {
  declare client: unknown;
  declare subscriptions: string[];
}

export class RecordsListRequestEvent extends CollectionScopedRequestEvent {
  declare records: RecordModel[];
  declare result: ListResult<unknown>;
}

export class RecordRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordCreateOTPRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel | null;
  declare password: string;
}

export class RecordAuthWithOTPRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
  declare otp: RecordModel;
}

export class RecordAuthRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
  declare token: string;
  declare meta: unknown;
  declare authMethod: string;
}

export class RecordAuthWithPasswordRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel | null;
  declare identity: string;
  declare identityField: string;
  declare password: string;
}

export class RecordAuthWithOAuth2RequestEvent extends CollectionScopedRequestEvent {
  declare providerName: string;
  declare providerClient: Provider;
  declare record: RecordModel | null;
  declare oauth2User: AuthUser;
  declare createData: Record<string, unknown>;
  declare isNewRecord: boolean;
}

export class RecordAuthRefreshRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordRequestPasswordResetRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordConfirmPasswordResetRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordRequestVerificationRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordConfirmVerificationRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
}

export class RecordRequestEmailChangeRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
  declare newEmail: string;
}

export class RecordConfirmEmailChangeRequestEvent extends CollectionScopedRequestEvent {
  declare record: RecordModel;
  declare newEmail: string;
}

export interface InternalRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export class BatchRequestEvent extends RequestHookEvent {
  declare batch: InternalRequest[];
}
