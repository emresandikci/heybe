import type { App } from "../app";
import type { Collection } from "../collections/model";
import { parseFilter } from "../filter/parse";
import { ApiError } from "../http/errors";
import type { RequestEvent } from "../http/router";
import { buildRequestInfo, matchesRecord } from "../records/rules";
import { NotFoundError, ValidationError, formatDate } from "../util";
import { hasExpired } from "./otp";
import { internalRecords } from "../records/internal";

type Values = Record<string, unknown>;

// PB core.MFAMethod*; "" skips MFA (auth refresh, impersonate).
export type MfaMethod = "password" | "otp" | "oauth2" | "";

const mfaOptions = (c: Collection) =>
  c.mfa as { enabled: boolean; duration: number; rule: string };
export const mfaDurationMs = (c: Collection) => mfaOptions(c).duration * 1000;

// PB wantsMFA: an empty rule means everyone, and a failing rule must not skip MFA.
function wantsMfa(
  e: RequestEvent,
  c: Collection,
  record: Values,
  body: Values,
  context: string,
): boolean {
  const { rule } = mfaOptions(c);
  if (rule === "") return true;
  try {
    return matchesRecord(
      e.app,
      c,
      record.id as string,
      parseFilter(rule),
      buildRequestInfo(e, body, context),
    );
  } catch {
    throw new ApiError(400, "Failed to authenticate.");
  }
}

function requestedMfaId(e: RequestEvent, body: Values): string {
  const fromQuery = e.query.get("mfaId") ?? "";
  if (fromQuery !== "") return fromQuery;
  const v = body.mfaId;
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  // multipart values come inferred but PB binds them as raw strings
  const multipart = (e.req.headers.get("content-type") ?? "").startsWith(
    "multipart/form-data",
  );
  if (multipart && (typeof v === "number" || typeof v === "boolean"))
    return String(v);
  throw new ApiError(400, "Failed to read MFA Id");
}

function findMfa(app: App, id: string): Values | null {
  try {
    return internalRecords(app, "_mfas").findRaw(id);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

// False when another request already used it, which keeps an mfaId single use under concurrency.
async function deleteMfa(app: App, id: string): Promise<boolean> {
  const { changes } = await app.db.write(() =>
    app.db.run("DELETE FROM _mfas WHERE id = ?", [id]),
  );
  return changes > 0;
}

// Replaces PB's hourly cron cleanup.
async function deleteExpiredMfas(app: App, c: Collection) {
  const oldest = new Date(app.now().getTime() - mfaOptions(c).duration * 1000);
  await app.db.write(() =>
    app.db.run("DELETE FROM _mfas WHERE collectionRef = ? AND created < ?", [
      c.id,
      formatDate(oldest),
    ]),
  );
}

// Port of PB checkMFA, shared by every auth method. Call it after the auth rule passed and before
// answering with a token. Returns the mfaId to answer with (401) when another method is still needed,
// or null when the login may complete.
export async function checkMfa(
  e: RequestEvent,
  c: Collection,
  record: Values,
  method: MfaMethod,
  body: Values,
  context: string,
): Promise<string | null> {
  if (!mfaOptions(c).enabled || method === "") return null;
  if (!wantsMfa(e, c, record, body, context)) return null;

  const mfaId = requestedMfaId(e, body);
  if (mfaId === "") {
    await deleteExpiredMfas(e.app, c);
    const created = await internalRecords(e.app, "_mfas").create({
      collectionRef: c.id,
      recordRef: record.id,
      method,
    });
    return created.id as string;
  }

  const mfa = findMfa(e.app, mfaId);
  if (!mfa || hasExpired(e.app, mfa, mfaOptions(c).duration * 1000)) {
    if (mfa) await deleteMfa(e.app, mfaId);
    throw new ApiError(400, "Invalid or expired MFA session.");
  }
  if (mfa.recordRef !== record.id || mfa.collectionRef !== c.id)
    throw new ApiError(400, "Invalid MFA session.");
  if (mfa.method === method)
    throw new ApiError(400, "A different authentication method is required.");
  if (!(await deleteMfa(e.app, mfaId)))
    throw new ApiError(400, "Invalid or expired MFA session.");
  return null;
}
