import { type Expr, type ListResult, toAst } from "@heybe/query";
import { verifyPassword } from "../../auth/password";
import type { App } from "../../app";
import type { Collection } from "../../collections/model";
import { fields } from "../../fields";
import { uniqueStrings } from "../../fields/shared";
import { FilterError, parseFilter, parseSort } from "../../filter/parse";
import type { RequestInfo } from "../../filter/compile";
import {
  checkCreateRule,
  checkRule,
  hasManageAccess,
  requestInfo,
  ruleFilter,
} from "../../records/rules";
import { isSuperuser, manageRuleOf } from "../../records/read";
import {
  expandModels,
  expandRecords,
  resolveFlags,
} from "../../records/expand";
import { RecordModel } from "../../records/model";
import {
  RecordEnrichEvent,
  RecordRequestEvent,
  RecordsListRequestEvent,
} from "../../hooks/events";
import { PasswordValue } from "../../fields/password";
import type { Hook } from "../../hooks/hook";
import { pickFields, pickItems } from "../../records/serialize";
import { type PreparedWrite, replaceModifiers } from "../../records/service";
import { ValidationError } from "../../util";
import { ApiError, logUnexpected } from "../errors";
import {
  BODY_LIMIT_ID,
  BODY_LIMIT_PRIORITY,
  DEFAULT_MAX_BODY_SIZE,
  applyBodyLimit,
} from "../middlewares";
import {
  type Middleware,
  RequestEvent,
  type Router,
  jsonResponse,
  markListResult,
} from "../router";
import { checkFilterAndSortLimits, parseListQuery } from "../list-query";
import {
  RATE_LIMIT_ID,
  checkCollectionRateLimit,
  checkRateLimit,
  randomizedThrottle,
} from "../rate-limit";
import { internalRecords } from "../../records/internal";

type Values = Record<string, unknown>;
type Finalizer = (record: RecordModel) => Promise<void>;
type Access = "default" | "manager" | "superuser";

const SUPERUSER_ONLY_FIELDS = ["@collection.", "@request."];
const CREATE_FAILED = "Failed to create record.";
const UPDATE_FAILED = "Failed to update record.";
const DELETE_FAILED =
  "Failed to delete record. Make sure that the record is not part of a required relation reference.";

function findCollection(e: RequestEvent): Collection {
  const c = e.app.collections.findCached(e.params.collection!);
  if (!c) throw new ApiError(404, "Missing collection context.");
  return c;
}

// Outside batches, create and update resolve the collection first in PB's dynamic body limit middleware.
const BODY_LIMIT_MISSING = "Missing or invalid collection context.";

export function writable(
  app: App,
  name: string,
  message = "Missing collection context.",
): Collection {
  const c = app.collections.findCached(name);
  if (!c) throw new ApiError(404, message);
  if (c.type === "view")
    throw new ApiError(400, "Unsupported collection type.");
  return c;
}

export function forbidUnlessSuperuser(
  info: RequestInfo,
  rule: string | null,
): void {
  if (rule === null && !isSuperuser(info))
    throw new ApiError(403, "Only superusers can perform this action.");
}

// Port of PB checkForSuperuserOnlyRuleFields.
export function checkClientFilterFields(info: RequestInfo): void {
  if (isSuperuser(info)) return;
  for (const param of ["filter", "sort"]) {
    const value = info.query[param] ?? "";
    for (const field of SUPERUSER_ONLY_FIELDS) {
      if (value.includes(field))
        throw new ApiError(403, `Only superusers can filter by ${field}`);
    }
  }
}

// strconv.Atoi and strconv.ParseBool, as PB search.Provider.Parse
const expandPaths = (info: RequestInfo) => (info.query.expand ?? "").split(",");

// Port of PB triggerRecordEnrichHooks: each record's onRecordEnrich chain runs inside the final
// action of the previous one, the last one runs `finalize`.
export async function triggerEnrich(
  app: App,
  requestInfo: RequestInfo,
  records: RecordModel[],
  finalize: () => void | Promise<void>,
): Promise<void> {
  if (records.length === 0) return;
  const hook = app.hooks.onRecordEnrich;
  if (hook.length === 0) return finalize();
  const run = async (i: number): Promise<void> => {
    if (i === records.length) return finalize();
    await hook.trigger(
      RecordEnrichEvent.of({ app, record: records[i]!, requestInfo }),
      () => run(i + 1),
    );
  };
  await run(0);
}

// Port of PB EnrichRecords (records of one collection): the enrich hooks around the default
// flags and the `expand` of the request.
export async function enrichRecords(
  e: RequestEvent,
  records: RecordModel[],
): Promise<void> {
  const info = await e.requestInfo();
  const app = e.app;
  await triggerEnrich(app, info, records, () => {
    const c = records[0]!.collection;
    resolveFlags(app, c, records, info);
    return expandModels(
      app,
      c,
      records,
      expandPaths(info),
      info,
      (rc, rels, request) => enrichExpanded(app, rc, rels, request),
    );
  });
}

// PB expandFetch: expanded records go through their enrich hooks around PB's default flags.
export const enrichExpanded = (
  app: App,
  c: Collection,
  records: RecordModel[],
  request: RequestInfo,
): Promise<void> =>
  triggerEnrich(app, request, records, () =>
    resolveFlags(app, c, records, request),
  );

const ENRICH_FAILED = "Failed to enrich record.";

async function enrichOrFail(
  e: RequestEvent,
  records: RecordModel[],
  message: string,
): Promise<void> {
  try {
    await enrichRecords(e, records);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logUnexpected(err);
    throw new ApiError(500, message);
  }
}

// PB optFinalizer: called with the event record at the end of the final action, or after the chain
// when it stopped before it.
async function triggerWithFinalizer<T extends RecordRequestEvent>(
  hook: Hook<T>,
  event: T,
  final: (e: T) => Promise<void>,
  finalizer?: Finalizer,
): Promise<void> {
  let called = false;
  const finalize = async (e: T) => {
    called = true;
    await finalizer?.(e.record);
  };
  await hook.trigger(event, async (e) => {
    await final(e);
    await finalize(e);
  });
  if (!called) await finalize(event);
}

// With no list, view or enrich handlers the records are serialized without building models.
const hooked = (app: App, handlers: number) =>
  handlers > 0 || app.hooks.onRecordEnrich.length > 0;

async function serialize(
  app: App,
  c: Collection,
  info: RequestInfo,
  id: string,
  rule: Expr | null,
) {
  const items = findById(app, c, info, id, false, rule);
  const [record] = await expandRecords(app, c, items, expandPaths(info), info);
  return pickFields(record!, info.query.fields);
}

function findById(
  app: App,
  c: Collection,
  info: RequestInfo,
  id: string,
  raw: boolean,
  rule: Expr | null,
): Values[] {
  let items: Values[];
  try {
    items = internalRecords(app, c.name).query({
      ruleFilter: rule,
      filter: toAst({ id }),
      perPage: 1,
      skipTotal: true,
      request: info,
      manageRule: manageRuleOf(c),
      raw,
    }).items;
  } catch (err) {
    if (rule === null) throw err;
    // like PB FindRecordById with a rule func: a rule that fails to run is a 404
    logUnexpected(err);
    throw new ApiError(404, "");
  }
  if (items.length === 0) throw new ApiError(404, "");
  return items;
}

// Port of PB dynamicCollectionBodyLimit.
const collectionBodyLimit: Middleware = {
  id: BODY_LIMIT_ID,
  priority: BODY_LIMIT_PRIORITY,
  fn: (e) => {
    const c = e.app.collections.findCached(e.params.collection ?? "");
    if (!c) throw new ApiError(404, "Missing or invalid collection context.");
    applyBodyLimit(
      e,
      c.type === "view"
        ? DEFAULT_MAX_BODY_SIZE
        : c.fields.reduce(
            (sum, f) => sum + (fields[f.type].maxBodySize?.(f) ?? 0),
            DEFAULT_MAX_BODY_SIZE,
          ),
    );
    return e.next();
  },
};

// Splits uploaded `File` values from the plain body values (multipart bodies have both).
function splitUploads(body: Values): {
  plain: Values;
  uploads: Map<string, File[]>;
} {
  const plain: Values = {};
  const uploads = new Map<string, File[]>();
  for (const [key, value] of Object.entries(body)) {
    const list = Array.isArray(value) ? value : [value];
    const files = list.filter((v): v is File => v instanceof File);
    if (files.length === 0) {
      plain[key] = value;
      continue;
    }
    uploads.set(key, files);
    const rest = list.filter((v) => !(v instanceof File));
    if (rest.length > 0) plain[key] = rest.length === 1 ? rest[0] : rest;
  }
  return { plain, uploads };
}

// Port of PB recordDataFromRequest: modifiers resolved, uploads merged, hidden fields dropped for non-superusers.
function recordData(
  c: Collection,
  info: RequestInfo,
  original: Values | null,
): Values {
  const { plain, uploads } = splitUploads(info.body);
  let data = replaceModifiers(c, original, plain);

  const uploaded: Values = {};
  for (const f of c.fields) {
    if (f.type !== "file") continue;
    for (const key of [f.name, `+${f.name}`, `${f.name}+`]) {
      const files = uploads.get(key);
      if (!files) continue;
      // a plain key keeps the submitted names, so existing files are not dropped by accident
      const kept =
        key === f.name && plain[key] !== undefined && plain[key] !== null
          ? uniqueStrings(plain[key])
          : [];
      uploaded[key] = [...kept, ...files];
    }
  }
  if (Object.keys(uploaded).length > 0)
    data = replaceModifiers(c, original, { ...data, ...uploaded });

  if (!isSuperuser(info)) {
    for (const f of c.fields) {
      if (f.hidden && !(c.type === "auth" && f.name === "password"))
        delete data[f.name];
    }
  }
  return data;
}

const asString = (v: unknown): string =>
  v === undefined || v === null
    ? ""
    : typeof v === "string"
      ? v
      : typeof v === "object"
        ? ""
        : String(v);

// A submitted old password checked against a password hash before the save, so validation can stay synchronous.
export interface OldPassword {
  hash: string;
  plain: string;
  ok: boolean;
}

export const hashOf = (record: Values) =>
  (record.password as { hash?: string } | undefined)?.hash ?? "";

// Checks the old password only when validateAuthForm needs it: an update of an auth record by
// a non-manager that changes the password.
export async function checkOldPassword(
  c: Collection,
  hash: string | null,
  data: Values,
  manager: boolean,
): Promise<OldPassword | null> {
  const plain = asString(data.oldPassword);
  const changes =
    asString(data.password) !== "" || asString(data.passwordConfirm) !== "";
  if (c.type !== "auth" || hash === null || manager || !changes || plain === "")
    return null;
  let ok = false;
  try {
    ok = await verifyPassword(plain, hash);
  } catch {}
  return { hash, plain, ok };
}

// fails closed when the check is missing or was made against another hash (a concurrent change)
const oldPasswordOk = (
  original: Values,
  plain: string,
  old: OldPassword | null,
) =>
  old !== null &&
  old.plain === plain &&
  old.hash === hashOf(original) &&
  old.ok;

// Port of PB forms.RecordUpsert validateFormFields (auth collections only): email and verified come
// from the record, which request hooks may have changed, the passwords from the submitted data.
function validateAuthForm(
  record: RecordModel,
  data: Values,
  original: Values | null,
  access: Access,
  message: string,
  old: OldPassword | null,
): void {
  if (record.collection.type !== "auth") return;
  const isNew = original === null;
  const manage = access !== "default";
  const password = asString(data.password);
  const confirm = asString(data.passwordConfirm);
  const oldPassword = asString(data.oldPassword);
  const mismatch = {
    code: "validation_values_mismatch",
    message: "Values don't match.",
  };
  const required = { code: "validation_required", message: "Cannot be blank." };
  const errors: Values = {};

  if (!isNew && !manage && record.get("email") !== original!.email)
    errors.email = mismatch;
  if (!manage && record.get("verified") !== (original?.verified ?? false))
    errors.verified = mismatch;

  const checkPasswords = !passwordSetOnRecord(record, password);
  if (
    checkPasswords &&
    (isNew || confirm !== "" || oldPassword !== "") &&
    password === ""
  )
    errors.password = required;
  if (
    checkPasswords &&
    (isNew || password !== "" || oldPassword !== "") &&
    confirm === ""
  )
    errors.passwordConfirm = required;
  else if (checkPasswords && confirm !== password)
    errors.passwordConfirm = mismatch;

  if (
    checkPasswords &&
    !isNew &&
    !manage &&
    (password !== "" || confirm !== "")
  ) {
    if (oldPassword === "") errors.oldPassword = required;
    else if (!oldPasswordOk(original!, oldPassword, old))
      errors.oldPassword = {
        code: "validation_invalid_old_password",
        message: "Missing or invalid old password.",
      };
  }

  if (Object.keys(errors).length > 0)
    throw new ValidationError(message, errors);
}

// PB syncPasswordFields: a password set on the record other than the submitted one (or a hash set
// on a new record) skips the form's password checks.
function passwordSetOnRecord(record: RecordModel, submitted: string): boolean {
  const v = record.get("password");
  if (!(v instanceof PasswordValue)) return false;
  return (
    (v.plain !== "" && v.plain !== submitted) ||
    (v.plain === "" && v.hash !== "" && record.isNew())
  );
}

function saveFailed(message: string, err: unknown): never {
  if (err instanceof ValidationError || err instanceof ApiError) throw err;
  logUnexpected(err);
  throw new ApiError(400, message);
}

export function createChecks(
  app: App,
  c: Collection,
  info: RequestInfo,
): { data: Values; access: Access } {
  forbidUnlessSuperuser(info, c.createRule);
  const data = recordData(c, info, null);
  info.body = data;
  let access: Access = isSuperuser(info) ? "superuser" : "default";
  if (access === "default") {
    checkCreateRule(app, c, data, info);
    if (hasManageAccess(app, c, info, { draft: data })) access = "manager";
  }
  return { data, access };
}

export function updateChecks(
  app: App,
  c: Collection,
  id: string,
  info: RequestInfo,
): { data: Values; original: Values; access: Access } {
  forbidUnlessSuperuser(info, c.updateRule);
  let original: Values;
  try {
    original = internalRecords(app, c.name).findRaw(id);
  } catch {
    throw new ApiError(404, "");
  }
  const data = recordData(c, info, original);
  info.body = data;
  ruleFilter(app, c, c.updateRule, "update", info, id);
  let access: Access = isSuperuser(info) ? "superuser" : "default";
  if (access === "default" && hasManageAccess(app, c, info, { id }))
    access = "manager";
  return { data, original, access };
}

const LIST_TIMING_RULE = {
  label: "",
  audience: "",
  maxRequests: 3,
  duration: 3,
};

// PB recordsList: a randomized delay when a client keeps sending filtered searches that find
// nothing, an extra guard against filter timing attacks.
async function throttleEmptySearches(
  e: RequestEvent,
  c: Collection,
  filter: string,
  found: number,
): Promise<void> {
  if (e.hasSuperuserAuth() || !c.listRule || filter === "" || found > 0) return;
  try {
    checkRateLimit(e, `@pb_list_timing_check_${c.id}`, LIST_TIMING_RULE);
  } catch {
    e.app.logger.debug(
      "Randomized throttle because of too many failed searches",
      { collectionId: c.id },
    );
    await randomizedThrottle(e.app, 500);
  }
}

async function list(e: RequestEvent): Promise<Response | void> {
  const c = findCollection(e);
  checkCollectionRateLimit(e, c, "list");
  const info = await requestInfo(e);
  forbidUnlessSuperuser(info, c.listRule);
  checkClientFilterFields(info);
  const rule = await checkRule(e.app, c, c.listRule, "list", e);
  const raw = hooked(e.app, e.app.hooks.onRecordsListRequest.length);

  let result: ListResult<Values>;
  try {
    const q = info.query;
    const { page, perPage, skipTotal } = parseListQuery(e.query);
    const sort = q.sort ?? "";
    const filter = q.filter ?? "";
    checkFilterAndSortLimits(filter, sort);
    const parsedFilter = parseFilter(filter);

    result = internalRecords(e.app, c.name).query({
      ruleFilter: rule,
      filter: parsedFilter,
      sort,
      page,
      perPage,
      skipTotal,
      request: info,
      manageRule: manageRuleOf(c),
      raw,
    });
    if (!raw) {
      const items = await expandRecords(
        e.app,
        c,
        result.items,
        expandPaths(info),
        info,
      );
      await throttleEmptySearches(e, c, filter, items.length);
      return jsonResponse(200, {
        ...result,
        items: pickItems(items, q.fields),
      });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logUnexpected(err);
    throw new ApiError(400, "");
  }

  const records = result.items.map((v) => new RecordModel(c, v, false));
  const event = RecordsListRequestEvent.from(e, {
    collection: c,
    records,
    result: markListResult({ ...result, items: records }),
  });
  await e.app.hooks.onRecordsListRequest.trigger(event, async (le) => {
    await enrichOrFail(le, le.records, "Failed to enrich records.");
    await throttleEmptySearches(
      le,
      c,
      info.query.filter ?? "",
      le.records.length,
    );
    le.json(200, le.result);
  });
}

async function view(e: RequestEvent): Promise<Response | void> {
  const c = findCollection(e);
  checkCollectionRateLimit(e, c, "view");
  const id = e.params.id!;
  const info = await requestInfo(e);
  const rule = ruleFilter(e.app, c, c.viewRule, "view", info);
  if (!hooked(e.app, e.app.hooks.onRecordViewRequest.length))
    return jsonResponse(200, await serialize(e.app, c, info, id, rule));
  const [values] = findById(e.app, c, info, id, true, rule);
  const event = RecordRequestEvent.from(e, {
    collection: c,
    record: new RecordModel(c, values!, false),
  });
  await e.app.hooks.onRecordViewRequest.trigger(event, async (ve) => {
    await enrichOrFail(ve, [ve.record], ENRICH_FAILED);
    ve.json(200, ve.record);
  });
}

async function prepareOrFail(
  app: App,
  c: Collection,
  data: Values,
  message: string,
  id?: string,
): Promise<PreparedWrite> {
  try {
    return await internalRecords(app, c.name).prepare(data, id);
  } catch (err) {
    saveFailed(message, err);
  }
}

async function create(e: RequestEvent): Promise<void> {
  const c = writable(e.app, e.params.collection!, BODY_LIMIT_MISSING);
  checkCollectionRateLimit(e, c, "create");
  const info = await requestInfo(e);
  const { data, access } = createChecks(e.app, c, info);
  const p = await prepareOrFail(e.app, c, data, CREATE_FAILED);
  await internalRecords(e.app, c.name).commit(p, () =>
    createRecord(e, c, p, data, access),
  );
}

async function update(e: RequestEvent): Promise<void> {
  const c = writable(e.app, e.params.collection!, BODY_LIMIT_MISSING);
  checkCollectionRateLimit(e, c, "update");
  const id = e.params.id!;
  const info = await requestInfo(e);
  const { data, original, access } = updateChecks(e.app, c, id, info);
  const old = await checkOldPassword(
    c,
    hashOf(original),
    data,
    access !== "default",
  );
  const p = await prepareOrFail(e.app, c, data, UPDATE_FAILED, id);
  await internalRecords(e.app, c.name).commit(p, () =>
    updateRecord(e, c, p, data, original, access, old),
  );
}

async function remove(e: RequestEvent): Promise<void> {
  const c = writable(e.app, e.params.collection!);
  checkCollectionRateLimit(e, c, "delete");
  await deleteRecord(e, c, e.params.id!);
}

// The rest of PB recordCreate: the create request hook around the form submit, enrich and response.
function createRecord(
  e: RequestEvent,
  c: Collection,
  p: PreparedWrite,
  data: Values,
  access: Access,
  finalizer?: Finalizer,
): Promise<void> {
  const record = internalRecords(e.app, c.name).draft(p, data);
  const event = RecordRequestEvent.from(e, { collection: c, record });
  return triggerWithFinalizer(
    e.app.hooks.onRecordCreateRequest,
    event,
    async (re) => {
      try {
        validateAuthForm(re.record, data, null, access, CREATE_FAILED, null);
        await internalRecords(re.app, c.name).savePrepared(p, re.record);
      } catch (err) {
        saveFailed(CREATE_FAILED, err);
      }
      await enrichOrFail(re, [re.record], ENRICH_FAILED);
      re.json(200, re.record);
    },
    finalizer,
  );
}

function updateRecord(
  e: RequestEvent,
  c: Collection,
  p: PreparedWrite,
  data: Values,
  original: Values,
  access: Access,
  old: OldPassword | null,
  finalizer?: Finalizer,
): Promise<void> {
  const record = internalRecords(e.app, c.name).draft(p, data, original);
  const event = RecordRequestEvent.from(e, { collection: c, record });
  return triggerWithFinalizer(
    e.app.hooks.onRecordUpdateRequest,
    event,
    async (re) => {
      try {
        validateAuthForm(re.record, data, original, access, UPDATE_FAILED, old);
        await internalRecords(re.app, c.name).savePrepared(p, re.record);
      } catch (err) {
        saveFailed(UPDATE_FAILED, err);
      }
      await enrichOrFail(re, [re.record], ENRICH_FAILED);
      re.json(200, re.record);
    },
    finalizer,
  );
}

async function deleteRecord(
  e: RequestEvent,
  c: Collection,
  id: string,
  finalizer?: Finalizer,
): Promise<void> {
  const info = await requestInfo(e);
  ruleFilter(e.app, c, c.deleteRule, "delete", info, id);
  const records = internalRecords(e.app, c.name);
  let values: Values;
  try {
    values = records.findRaw(id);
  } catch {
    throw new ApiError(404, "");
  }
  const event = RecordRequestEvent.from(e, {
    collection: c,
    record: new RecordModel(c, values, false),
  });
  await triggerWithFinalizer(
    e.app.hooks.onRecordDeleteRequest,
    event,
    async (de) => {
      try {
        await records.deleteRecord(de.record);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        logUnexpected(err);
        throw new ApiError(400, DELETE_FAILED);
      }
      de.noContent(204);
    },
    finalizer,
  );
}

// PB sendOAuth2RecordCreateRequest (processInternalRequest): the create route with its request hooks
// as an internal request of `e`, on a prepared record. Returns the record it created.
export async function internalCreate(
  e: RequestEvent,
  c: Collection,
  info: RequestInfo,
  p: PreparedWrite,
): Promise<RecordModel> {
  const headers = new Headers(e.req.headers);
  headers.set("content-type", "multipart/form-data");
  const req = new Request(
    new URL(`/api/collections/${c.name}/records`, e.req.url),
    { method: "POST", headers },
  );
  const sub = RequestEvent.internal(e, req, { collection: c.name }, info);
  let created: RecordModel | null = null;
  await batchCreate(sub, c, p, async (record) => {
    created = record;
  });
  // like PB's response recorder, no written response is a 200
  if ((sub.response?.status ?? 200) !== 200 || !created)
    throw new Error("failed to create OAuth2 auth record");
  return created;
}

// The write routes for batch sub-requests (`e` from RequestEvent.internal), with the uploads and
// hashes prepared before the batch transaction.
// `next` runs the next sub-request (PB optFinalizer).
export async function batchCreate(
  e: RequestEvent,
  c: Collection,
  p: PreparedWrite,
  next: Finalizer,
): Promise<void> {
  checkCollectionRateLimit(e, c, "create");
  const { data, access } = createChecks(e.app, c, await requestInfo(e));
  await createRecord(e, c, p, data, access, next);
}

export async function batchUpdate(
  e: RequestEvent,
  c: Collection,
  id: string,
  p: PreparedWrite,
  old: OldPassword | null,
  next: Finalizer,
): Promise<void> {
  checkCollectionRateLimit(e, c, "update");
  const info = await requestInfo(e);
  const { data, original, access } = updateChecks(e.app, c, id, info);
  await updateRecord(e, c, p, data, original, access, old, next);
}

export function batchDelete(
  e: RequestEvent,
  c: Collection,
  id: string,
  next?: Finalizer,
): Promise<void> {
  checkCollectionRateLimit(e, c, "delete");
  return deleteRecord(e, c, id, next);
}

export function registerRecordRoutes(router: Router): void {
  // the rate limit is checked in the handlers, since batches run them too (PB)
  const base = "/api/collections/{collection}/records";
  router.route("GET", base, list).unbind(RATE_LIMIT_ID);
  router.route("GET", `${base}/{id}`, view).unbind(RATE_LIMIT_ID);
  router.route("POST", base, create, collectionBodyLimit).unbind(RATE_LIMIT_ID);
  router
    .route("PATCH", `${base}/{id}`, update, collectionBodyLimit)
    .unbind(RATE_LIMIT_ID);
  router.route("DELETE", `${base}/{id}`, remove).unbind(RATE_LIMIT_ID);
}
