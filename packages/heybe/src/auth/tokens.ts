import type { App } from "../app";
import type { Collection } from "../collections/model";
import type { AuthState } from "../http/router";
import { NotFoundError } from "../util";
import { parseUnverifiedJwt, signJwt, verifyJwt } from "./jwt";

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

export function authFromToken(
  app: App,
  token: string,
  type: "auth" | "file" = "auth",
): AuthState | null {
  const claims = parseUnverifiedJwt(token, app.now);
  if (!claims || claims.type !== type) return null;
  const { id, collectionId } = claims;
  if (typeof id !== "string" || typeof collectionId !== "string") return null;

  const collection = app.collections.find(collectionId);
  if (!collection || collection.type !== "auth") return null;

  let record: Record<string, unknown>;
  try {
    record = app.records(collection.name).findRaw(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
  const config = (
    type === "auth" ? collection.authToken : collection.fileToken
  ) as TokenConfig;
  const secret = `${record.tokenKey}${config.secret}`;
  if (!verifyJwt(token, secret, app.now)) return null;
  return {
    record,
    collection,
    isSuperuser: collection.name === "_superusers",
  };
}
