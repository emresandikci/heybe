import { toAst } from "@heybe/query";
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
import { expandRecords } from "../../records/expand";
import { pickFields, pickItems } from "../../records/serialize";
import { type PreparedWrite, replaceModifiers } from "../../records/service";
import { ValidationError } from "../../util";
import { ApiError, logUnexpected } from "../errors";
import { DEFAULT_MAX_BODY_SIZE } from "../middlewares";
import type { RequestEvent, Router } from "../router";

type Values = Record<string, unknown>;
type Access = "default" | "manager" | "superuser";

const MAX_FILTER_LENGTH = 3500;
const MAX_SORT_FIELDS = 8;
const MAX_SORT_FIELD_LENGTH = 255;
const INT64_MAX = 2n ** 63n - 1n;
const SUPERUSER_ONLY_FIELDS = ["@collection.", "@request."];
const CREATE_FAILED = "Failed to create record.";
const UPDATE_FAILED = "Failed to update record.";
const DELETE_FAILED =
  "Failed to delete record. Make sure that the record is not part of a required relation reference.";

function findCollection(e: RequestEvent): Collection {
  const c = e.app.collections.find(e.params.collection!);
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
  const c = app.collections.find(name);
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
function checkClientFilterFields(info: RequestInfo): void {
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
function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[+-]?\d+$/.test(value) || BigInt(value) > INT64_MAX)
    throw new FilterError("invalid number");
  return Number(value);
}

function bool(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (/^(1|t|T|TRUE|true|True)$/.test(value)) return true;
  if (/^(0|f|F|FALSE|false|False)$/.test(value)) return false;
  throw new FilterError("invalid bool");
}

const expandPaths = (info: RequestInfo) => (info.query.expand ?? "").split(",");

function serialize(app: App, c: Collection, info: RequestInfo, id: string) {
  const { items } = app.records(c.name).query({
    filter: toAst({ id }),
    perPage: 1,
    skipTotal: true,
    request: info,
    manageRule: manageRuleOf(c),
  });
  if (items.length === 0) throw new ApiError(404, "");
  const [record] = expandRecords(app, c, items, expandPaths(info), info);
  return pickFields(record!, info.query.fields);
}

// Port of PB dynamicCollectionBodyLimit.
function collectionBodyLimit(app: App, params: Record<string, string>): number {
  const c = app.collections.find(params.collection!);
  if (!c) throw new ApiError(404, "Missing or invalid collection context.");
  if (c.type === "view") return DEFAULT_MAX_BODY_SIZE;
  return c.fields.reduce(
    (sum, f) => sum + (fields[f.type].maxBodySize?.(f) ?? 0),
    DEFAULT_MAX_BODY_SIZE,
  );
}

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
    ok = await Bun.password.verify(plain, hash);
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

// Port of PB forms.RecordUpsert validateFormFields (auth collections only).
function validateAuthForm(
  c: Collection,
  data: Values,
  original: Values | null,
  access: Access,
  message: string,
  old: OldPassword | null,
): void {
  if (c.type !== "auth") return;
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

  const email = "email" in data ? data.email : original?.email;
  if (!isNew && !manage && email !== original!.email) errors.email = mismatch;
  const verified =
    "verified" in data ? data.verified : (original?.verified ?? false);
  if (!manage && verified !== (original?.verified ?? false))
    errors.verified = mismatch;

  if ((isNew || confirm !== "" || oldPassword !== "") && password === "")
    errors.password = required;
  if ((isNew || password !== "" || oldPassword !== "") && confirm === "")
    errors.passwordConfirm = required;
  else if (confirm !== password) errors.passwordConfirm = mismatch;

  if (!isNew && !manage && (password !== "" || confirm !== "")) {
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
    original = app.records(c.name).findRaw(id);
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

async function list(e: RequestEvent): Promise<Response> {
  const c = findCollection(e);
  const info = await requestInfo(e);
  forbidUnlessSuperuser(info, c.listRule);
  checkClientFilterFields(info);
  const rule = await checkRule(e.app, c, c.listRule, "list", e);

  try {
    const q = info.query;
    const skipTotal = bool(q.skipTotal);
    const page = int(q.page, 1);
    const perPage = int(q.perPage, 0);
    const sort = q.sort ?? "";
    const filter = q.filter ?? "";
    if (Buffer.byteLength(filter) > MAX_FILTER_LENGTH)
      throw new FilterError("max filter length limit reached");
    const parsedFilter = parseFilter(filter);
    const sortFields = parseSort(sort);
    if (sortFields.length > MAX_SORT_FIELDS)
      throw new FilterError("max sort expressions limit reached");
    if (sortFields.some((s) => s.field.length > MAX_SORT_FIELD_LENGTH))
      throw new FilterError("max sort field length limit reached");

    const result = e.app.records(c.name).query({
      ruleFilter: rule,
      filter: parsedFilter,
      sort,
      page,
      perPage,
      skipTotal,
      request: info,
      manageRule: manageRuleOf(c),
    });
    const items = expandRecords(
      e.app,
      c,
      result.items as Values[],
      expandPaths(info),
      info,
    );
    return e.json(200, {
      items: pickItems(items, q.fields),
      page: result.page,
      perPage: result.perPage,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logUnexpected(err);
    throw new ApiError(400, "");
  }
}

async function view(e: RequestEvent): Promise<Response> {
  const c = findCollection(e);
  const id = e.params.id!;
  const info = await requestInfo(e);
  await checkRule(e.app, c, c.viewRule, "view", e, id);
  return e.json(200, serialize(e.app, c, info, id));
}

async function create(e: RequestEvent): Promise<Response> {
  const c = writable(e.app, e.params.collection!, BODY_LIMIT_MISSING);
  const info = await requestInfo(e);
  const { data, access } = createChecks(e.app, c, info);
  let saved: Values;
  try {
    validateAuthForm(c, data, null, access, CREATE_FAILED, null);
    saved = await e.app.records(c.name).create(data);
  } catch (err) {
    saveFailed(CREATE_FAILED, err);
  }
  return e.json(200, serialize(e.app, c, info, saved.id as string));
}

async function update(e: RequestEvent): Promise<Response> {
  const c = writable(e.app, e.params.collection!, BODY_LIMIT_MISSING);
  const id = e.params.id!;
  const info = await requestInfo(e);
  const { data, original, access } = updateChecks(e.app, c, id, info);
  try {
    const manager = access !== "default";
    const old = await checkOldPassword(c, hashOf(original), data, manager);
    validateAuthForm(c, data, original, access, UPDATE_FAILED, old);
    await e.app.records(c.name).update(id, data);
  } catch (err) {
    saveFailed(UPDATE_FAILED, err);
  }
  return e.json(200, serialize(e.app, c, info, id));
}

async function remove(e: RequestEvent): Promise<Response> {
  const c = writable(e.app, e.params.collection!);
  const id = e.params.id!;
  ruleFilter(e.app, c, c.deleteRule, "delete", await requestInfo(e), id);
  try {
    await e.app.records(c.name).delete(id);
  } catch (err) {
    logUnexpected(err);
    throw new ApiError(400, DELETE_FAILED);
  }
  return new Response(null, { status: 204 });
}

// Batch versions of the write routes: the same checks, written synchronously inside the batch
// transaction with the uploads and hashes prepared before it.
export interface BatchResult {
  body: unknown;
  status: number;
}

// The create route's checks and write on a prepared record (batch and OAuth2 sign-up).
export function createPreparedChecked(
  app: App,
  c: Collection,
  info: RequestInfo,
  p: PreparedWrite,
): Values {
  const { data, access } = createChecks(app, c, info);
  try {
    validateAuthForm(c, data, null, access, CREATE_FAILED, null);
    return app.records(c.name).createPrepared(p, data);
  } catch (err) {
    saveFailed(CREATE_FAILED, err);
  }
}

export function batchCreate(
  app: App,
  c: Collection,
  info: RequestInfo,
  p: PreparedWrite,
): BatchResult {
  const saved = createPreparedChecked(app, c, info, p);
  return { body: serialize(app, c, info, saved.id as string), status: 200 };
}

export function batchUpdate(
  app: App,
  c: Collection,
  id: string,
  info: RequestInfo,
  p: PreparedWrite,
  old: OldPassword | null,
): BatchResult {
  const { data, original, access } = updateChecks(app, c, id, info);
  try {
    validateAuthForm(c, data, original, access, UPDATE_FAILED, old);
    app.records(c.name).updatePrepared(p, id, data);
  } catch (err) {
    saveFailed(UPDATE_FAILED, err);
  }
  return { body: serialize(app, c, info, id), status: 200 };
}

export function batchDelete(
  app: App,
  c: Collection,
  id: string,
  info: RequestInfo,
  p: PreparedWrite,
): BatchResult {
  ruleFilter(app, c, c.deleteRule, "delete", info, id);
  try {
    app.records(c.name).deletePrepared(p, id);
  } catch (err) {
    logUnexpected(err);
    throw new ApiError(400, DELETE_FAILED);
  }
  return { body: null, status: 204 };
}

export function registerRecordRoutes(router: Router): void {
  const base = "/api/collections/{collection}/records";
  router.add("GET", base, list);
  router.add("GET", `${base}/{id}`, view);
  router.add("POST", base, create, { bodyLimit: collectionBodyLimit });
  router.add("PATCH", `${base}/{id}`, update, {
    bodyLimit: collectionBodyLimit,
  });
  router.add("DELETE", `${base}/{id}`, remove);
}
