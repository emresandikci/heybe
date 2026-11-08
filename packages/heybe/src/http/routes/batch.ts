import type { App } from "../../app";
import type { Collection } from "../../collections/model";
import { PasswordValue } from "../../fields/password";
import { toStr } from "../../fields/shared";
import { mimeExtension, sniffMime } from "../../files/mime";
import { normalizeFilename } from "../../files/name";
import type { RequestInfo } from "../../filter/compile";
import { buildRequestInfo, headerKey, ruleFilter } from "../../records/rules";
import type { PreparedWrite } from "../../records/service";
import { NotFoundError, ValidationError } from "../../util";
import { ApiError, logUnexpected, toApiError } from "../errors";
import { BODY_LIMIT_ID, applyBodyLimit } from "../middlewares";
import { requestFiles } from "../multipart";
import { RequestEvent, type Router } from "../router";
import { BatchRequestEvent, type InternalRequest } from "../../hooks/events";
import {
  type OldPassword,
  batchCreate,
  batchDelete,
  batchUpdate,
  checkOldPassword,
  createChecks,
  hashOf,
  updateChecks,
  writable,
} from "./records";
import { internalRecords } from "../../records/internal";

type Values = Record<string, unknown>;
type Action = "create" | "update" | "upsert" | "delete";
// latest password hash per auth record ("<collectionId>/<id>"), null when it does not exist
type Hashes = Map<string, string | null>;

interface BatchResult {
  body: unknown;
  status: number;
}

interface Item {
  action: Action;
  collection: string;
  id: string;
  body: Values;
  headers: Record<string, string>;
  info: RequestInfo;
  c?: Collection;
  p?: PreparedWrite;
  old?: OldPassword | null;
  // the request failed while preparing; reported when the batch reaches it
  error?: unknown;
}

const DEFAULT_TIMEOUT = 3;
const DEFAULT_BATCH_MAX_BODY_SIZE = 128 << 20;
const MAX_URL_LENGTH = 2000;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const READ_FAILED = "Failed to read the submitted batch data.";
const TIMEOUT = new Error("batch transaction timeout");
const UNKNOWN_ACTION = new Error("unknown batch request action");
const INTERRUPTED = new Error("batch request interrupted");

// Port of PB ValidBatchActions.
const ACTIONS: [Action, RegExp][] = [
  ["upsert", /^PUT \/api\/collections\/(?<c>[^/?]+)\/records(?<q>\?.*)?$/],
  ["create", /^POST \/api\/collections\/(?<c>[^/?]+)\/records(?<q>\?.*)?$/],
  [
    "update",
    /^PATCH \/api\/collections\/(?<c>[^/?]+)\/records\/(?<id>[^/?]+)(?<q>\?.*)?$/,
  ],
  [
    "delete",
    /^DELETE \/api\/collections\/(?<c>[^/?]+)\/records\/(?<id>[^/?]+)(?<q>\?.*)?$/,
  ],
];

const isObject = (v: unknown): v is Values =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function readFailed(): never {
  throw new ApiError(400, READ_FAILED);
}

const str = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : readFailed();

const obj = (v: unknown): Values =>
  v === undefined || v === null ? {} : isObject(v) ? { ...v } : readFailed();

function toInternal(raw: unknown): InternalRequest | null {
  if (raw === null) return null;
  if (!isObject(raw)) readFailed();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(raw.headers))) headers[k] = str(v);
  return {
    method: str(raw.method),
    url: str(raw.url),
    body: obj(raw.body),
    headers,
  };
}

// Port of PB batchTransaction body binding: JSON or `@jsonPayload`, files under `requests.N.field`.
// The form is validated before the files are attached, so an oversized batch costs no file work.
async function readRequests(
  e: RequestEvent,
  max: number,
): Promise<InternalRequest[]> {
  let data: Values;
  try {
    data = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    readFailed();
  }
  const raw = data.requests ?? [];
  if (!Array.isArray(raw)) readFailed();
  const requests = raw.map(toInternal);
  validate(requests, max);
  const valid = requests as InternalRequest[];
  if (!e.req.headers.get("content-type")?.startsWith("multipart/form-data"))
    return valid;
  for (const [i, files] of requestFiles(data)) {
    const r = valid[i];
    if (!r) continue;
    for (const [key, list] of files)
      r.body[key] = await Promise.all(list.map(renamed));
  }
  return valid;
}

// PB names a batch file when reading the batch and again when the record route reads it
async function renamed(f: File): Promise<File> {
  const ext = mimeExtension(await sniffMime(f));
  return new File([f], normalizeFilename(f.name, ext), { type: f.type });
}

const fieldError = (code: string, message: string, params?: Values) =>
  params ? { code, message, params } : { code, message };

function validate(requests: (InternalRequest | null)[], max: number): void {
  const invalid = (data: Values) =>
    new ApiError(400, "Invalid batch request data.", { requests: data });
  const tooLong = (max: number) =>
    fieldError(
      "validation_length_too_long",
      `The length must be no more than ${max}.`,
      { max, min: 0 },
    );
  const required = fieldError("validation_required", "Cannot be blank.");

  if (requests.length === 0) throw invalid(required);
  if (requests.length > max) throw invalid(tooLong(max));
  const errors: Values = {};
  requests.forEach((r, i) => {
    // PB panics on a null request
    if (r === null) throw new ApiError(500, "");
    const e: Values = {};
    if (r.method === "") e.method = required;
    else if (!METHODS.includes(r.method))
      e.method = fieldError("validation_in_invalid", "Must be a valid value.");
    if (r.url === "") e.url = required;
    else if ([...r.url].length > MAX_URL_LENGTH)
      e.url = tooLong(MAX_URL_LENGTH);
    if (Object.keys(e).length > 0) errors[i] = e;
  });
  if (Object.keys(errors).length > 0) throw invalid(errors);
}

function plan(e: RequestEvent, r: InternalRequest): Item {
  const info = buildRequestInfo(e, r.body, "batch");
  info.method = r.method;
  // the auth state comes from the batch request only
  for (const [k, v] of Object.entries(r.headers))
    if (k.toLowerCase() !== "authorization") info.headers[headerKey(k)] = v;
  info.headers.content_type = "multipart/form-data";

  const full = `${r.method} ${r.url}`;
  for (const [action, re] of ACTIONS) {
    const groups = re.exec(full)?.groups;
    if (!groups) continue;
    info.query = {};
    for (const [k, v] of new URLSearchParams(groups.q ?? ""))
      info.query[k] ??= v;
    const { c, id = "" } = groups;
    return {
      action,
      collection: c!,
      id,
      body: r.body,
      headers: r.headers,
      info,
    };
  }
  return {
    action: "create",
    collection: "",
    id: "",
    body: r.body,
    headers: r.headers,
    info,
    error: UNKNOWN_ACTION,
  };
}

function find(app: App, c: Collection, id: string): Values | null {
  try {
    return id === "" ? null : internalRecords(app, c.name).findRaw(id);
  } catch {
    return null;
  }
}

// the record a PUT updates, null when it creates (PB upsert)
function upsertTarget(app: App, c: Collection, item: Item): string | null {
  if (item.action !== "upsert") return null;
  const id = toStr(item.body.id);
  return find(app, c, id) ? id : null;
}

// The request's checks as the database stands now, on a copy of its request info.
function check(app: App, item: Item): void {
  if (item.error === UNKNOWN_ACTION) throw item.error;
  const c = writable(app, item.collection);
  const info = { ...item.info };
  if (item.action === "delete")
    ruleFilter(app, c, c.deleteRule, "delete", info, item.id);
  else if (item.action === "update") updateChecks(app, c, item.id, info);
  else {
    const id = upsertTarget(app, c, item);
    if (id !== null) updateChecks(app, c, id, { ...info, method: "PATCH" });
    else createChecks(app, c, { ...info, method: "POST" });
  }
}

// Async work done before the transaction: uploads, password hashes and the old password check.
async function prepare(app: App, item: Item, hashes: Hashes): Promise<void> {
  try {
    const c = writable(app, item.collection);
    const records = internalRecords(app, c.name);
    if (item.action === "delete") {
      item.p = await records.prepare({}, item.id);
      hashes.set(`${c.id}/${item.id}`, null);
    } else {
      const id = item.action === "update" ? item.id : undefined;
      item.p = await records.prepare(item.body, id);
      if (c.type === "auth") await trackPassword(app, c, item, hashes);
    }
    item.c = c;
  } catch (err) {
    item.error = err;
  }
}

// The old password is checked against the hash the record will have when the batch reaches the
// request, so earlier password changes in the same batch are taken into account.
async function trackPassword(
  app: App,
  c: Collection,
  item: Item,
  hashes: Hashes,
): Promise<void> {
  const id = item.p!.ctx.recordId;
  const key = `${c.id}/${id}`;
  let current = hashes.get(key);
  if (current === undefined) {
    const stored = find(app, c, id);
    current = stored ? hashOf(stored) : null;
  }
  const update =
    item.action === "update" ||
    (item.action === "upsert" &&
      toStr(item.body.id) !== "" &&
      current !== null);
  if (update) item.old = await checkOldPassword(c, current, item.body, false);
  const set = item.p!.resolved.get("password")?.get(item.body.password);
  if (set instanceof PasswordValue && set.hash !== "")
    hashes.set(key, set.hash);
  else if (!update) hashes.set(key, "");
}

// Runs the record route of a request on its own event, the result is what it answered.
async function write(
  e: RequestEvent,
  item: Item,
  next: () => Promise<void>,
): Promise<BatchResult> {
  const c = item.c!;
  const p = item.p!;
  const info = { ...item.info };
  let action = item.action;
  let id = item.id;
  if (action === "upsert") {
    const target = upsertTarget(e.app, c, item);
    action = target === null ? "create" : "update";
    id = target ?? "";
    info.method = target === null ? "POST" : "PATCH";
  }
  const headers = new Headers(e.req.headers);
  for (const [k, v] of Object.entries(item.headers))
    if (k.toLowerCase() !== "authorization") headers.set(k, v);
  headers.set("content-type", "multipart/form-data");
  const path = `/api/collections/${item.collection}/records${id ? `/${id}` : ""}`;
  const search = new URLSearchParams(info.query).toString();
  const req = new Request(
    new URL(`${path}${search ? `?${search}` : ""}`, e.req.url),
    { method: info.method, headers },
  );
  const sub = RequestEvent.internal(
    e,
    req,
    { collection: item.collection, id },
    info,
  );
  if (action === "delete") await batchDelete(sub, c, id, next);
  else if (action === "update")
    await batchUpdate(sub, c, id, p, item.old ?? null, next);
  else await batchCreate(sub, c, p, next);
  const res = sub.response;
  if (!res) return { body: null, status: 200 };
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {}
  return { body, status: res.status };
}

const isApiLike = (err: unknown) =>
  err instanceof ApiError ||
  err instanceof ValidationError ||
  err instanceof NotFoundError;

function responseError(err: unknown): ApiError {
  if (isApiLike(err)) return toApiError(err);
  if (err !== UNKNOWN_ACTION) logUnexpected(err);
  return new ApiError(400, "");
}

// the error of a later request as the earlier one hands it back (PB firstApiError with a 500)
function nestedError(err: unknown): unknown {
  if (isApiLike(err)) return err;
  if (err !== UNKNOWN_ACTION) logUnexpected(err);
  return new ApiError(500, "");
}

// Port of PB batchTransaction: every request runs with the batch caller's auth and the collection
// rules, all writes in one transaction. Uploads and password hashes are prepared before it and
// settled after it. Preparing stops at the first request whose checks fail on the database as it
// is (PB stops there too); the transaction checks such a request again after the earlier writes and
// prepares it there when it passes.
async function batch(e: RequestEvent): Promise<void> {
  const settings = e.app.settings.get().batch;
  if (!settings.enabled || settings.maxRequests <= 0)
    throw new ApiError(403, "Batch requests are not allowed.");
  const timeout =
    (settings.timeout > 0 ? settings.timeout : DEFAULT_TIMEOUT) * 1000;
  // the body limit is inlined like PB
  applyBodyLimit(
    e,
    settings.maxBodySize > 0
      ? settings.maxBodySize
      : DEFAULT_BATCH_MAX_BODY_SIZE,
  );

  const requests = await readRequests(e, settings.maxRequests);
  const event = BatchRequestEvent.from(e, { batch: requests });
  await e.app.hooks.onBatchRequest.trigger(event, (be) =>
    run(be, be.batch, timeout),
  );
}

async function run(
  e: RequestEvent,
  requests: InternalRequest[],
  timeout: number,
): Promise<void> {
  const items = requests.map((r) => plan(e, r));

  const started = e.app.now().getTime();
  const signal = e.req.signal;
  // PB stops processing on a timeout or a client disconnect, the transaction then fails with it
  let stop: Error | null = null;
  const timedOut = () => e.app.now().getTime() - started >= timeout;
  const halted = (checkTime = true) => {
    if (signal.aborted) stop ??= INTERRUPTED;
    else if (checkTime && timedOut()) stop ??= TIMEOUT;
    return stop !== null;
  };
  const interrupted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(INTERRUPTED);
    signal.addEventListener("abort", () => reject(INTERRUPTED), {
      once: true,
    });
  });
  interrupted.catch(() => {});
  const hashes: Hashes = new Map();
  const results: BatchResult[] = [];
  let failed = 0;
  let error: unknown = null;

  // Port of PB batchProcessor.process: request i+1 runs from request i's finalizer, so later
  // requests run inside the earlier request hooks and their errors come back through them.
  const process = async (i: number): Promise<void> => {
    const item = items[i];
    if (!item || halted(i > 0)) return;
    const result = await runItem(e, item, hashes, halted, async () => {
      try {
        await process(i + 1);
      } catch (err) {
        if (failed === 0) failed = i + 1;
        throw nestedError(err);
      }
    });
    if (result) results[i] = result;
  };

  try {
    for (const item of items) {
      try {
        check(e.app, item);
      } catch {
        break;
      }
      await prepare(e.app, item, hashes);
      if (timedOut()) throw TIMEOUT;
      if (item.error) break;
    }
    await e.app.db.write(async () => {
      const running = process(0);
      try {
        await Promise.race([running, interrupted]);
      } catch (err) {
        // an interrupted request finishes inside the transaction, so it is rolled back with it
        await running.catch(() => {});
        throw err;
      }
      halted();
      if (stop) throw stop;
    });
  } catch (err) {
    error = err;
  }

  for (const item of items)
    if (item.p)
      await internalRecords(e.app, item.p.ctx.collection.name).settle(item.p);

  if (error === TIMEOUT || error === INTERRUPTED)
    throw new ApiError(400, "Batch transaction failed.");
  if (error !== null) {
    const response = responseError(error);
    throw new ApiError(400, "Batch transaction failed.", {
      requests: {
        [failed]: {
          code: "batch_request_failed",
          message: "Batch request failed.",
          response: {
            data: response.data,
            message: response.message,
            status: response.status,
          },
        },
      },
    });
  }
  e.json(200, results);
}

// One request inside the transaction: its checks come before its prepare error, like the route.
async function runItem(
  e: RequestEvent,
  item: Item,
  hashes: Hashes,
  halted: () => boolean,
  next: () => Promise<void>,
): Promise<BatchResult | null> {
  const app = e.app;
  if (!item.p) {
    check(app, item);
    if (!item.error) {
      await prepare(app, item, hashes);
      if (halted()) return null;
    }
  }
  if (item.error) throw item.error;
  return write(e, item, next);
}

export function registerBatchRoutes(router: Router): void {
  router.route("POST", "/api/batch", batch).unbind(BODY_LIMIT_ID);
}
