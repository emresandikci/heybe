import type { App } from "../app";
import type { Collection } from "../collections/model";
import type { AuthState } from "../http/router";
import { NotFoundError } from "../util";
import { parseUnverifiedJwt, signJwt, verifyJwt } from "./jwt";
import { internalRecords } from "../records/internal";

interface TokenConfig {
  secret: string;
  duration: number;
}

export function newAuthToken(
  app: App,
  collection: Collection,
  record: Record<string, unknown>,
  opts: { duration?: number; refreshable?: boolean } = {},
): string {
  const config = collection.authToken as TokenConfig;
  return signJwt(
    {
      type: "auth",
      id: record.id,
      collectionId: collection.id,
      refreshable: opts.refreshable ?? true,
      exp:
        Math.floor(app.now().getTime() / 1000) +
        (opts.duration ?? config.duration),
    },
    `${record.tokenKey}${config.secret}`,
  );
}

export function newFileToken(
  app: App,
  collection: Collection,
  record: Record<string, unknown>,
): string {
  const config = collection.fileToken as TokenConfig;
  return signJwt(
    {
      type: "file",
      id: record.id,
      collectionId: collection.id,
      exp: Math.floor(app.now().getTime() / 1000) + config.duration,
    },
    `${record.tokenKey}${config.secret}`,
  );
}

// PB FindAuthRecordByToken: the secret is the record tokenKey plus the type's collection secret, so a
// tokenKey rotation (password or email change) invalidates every token of the record.
export function authFromToken(
  app: App,
  token: string,
  type: TokenType = "auth",
): AuthState | null {
  const claims = parseUnverifiedJwt(token, app.now);
  if (!claims || claims.type !== type) return null;
  const { id, collectionId } = claims;
  if (typeof id !== "string" || typeof collectionId !== "string") return null;

  const collection = app.collections.findCached(collectionId);
  if (!collection || collection.type !== "auth") return null;

  let record: Record<string, unknown>;
  try {
    record = internalRecords(app, collection.name).findRaw(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const config = collection[TOKEN_CONFIG[type]] as TokenConfig;
  const secret = `${record.tokenKey}${config.secret}`;
  if (!verifyJwt(token, secret, app.now)) return null;
  return {
    record,
    collection,
    isSuperuser: collection.name === "_superusers",
  };
}

type MailTokenKind = "verification" | "passwordReset" | "emailChange";

export type TokenType = "auth" | "file" | MailTokenKind;

const TOKEN_CONFIG = {
  auth: "authToken",
  file: "fileToken",
  verification: "verificationToken",
  passwordReset: "passwordResetToken",
  emailChange: "emailChangeToken",
} as const;

export function newMailToken(
  app: App,
  kind: MailTokenKind,
  collection: Collection,
  record: Record<string, unknown>,
  newEmail?: string,
): string {
  const config = collection[TOKEN_CONFIG[kind]] as TokenConfig;
  return signJwt(
    {
      type: kind,
      id: record.id,
      collectionId: collection.id,
      email: record.email,
      ...(kind === "emailChange" ? { newEmail } : {}),
      exp: Math.floor(app.now().getTime() / 1000) + config.duration,
    },
    `${record.tokenKey}${config.secret}`,
  );
}
