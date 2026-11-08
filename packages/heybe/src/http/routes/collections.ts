import type { App } from "../../app";
import { providers } from "../../auth/oauth2/providers";
import { decodeCollection, serializeCollection } from "../../collections/codec";
import { sqliteMessage } from "../../collections/ddl";
import { DecodeError, withDefaults } from "../../collections/field-settings";
import { type Collection, type CollectionType } from "../../collections/model";
import { compileCollectionsQuery } from "../../collections/search";
import { dryRunView } from "../../collections/view";
import {
  authSystemFields,
  idField,
  scaffold,
} from "../../collections/scaffold";
import { FilterError } from "../../filter/parse";
import { pickFields } from "../../records/serialize";
import { ValidationError, newId } from "../../util";
import { ApiError } from "../errors";
import {
  type RequestEvent,
  type Router,
  jsonResponse,
  markListResult,
} from "../router";
import {
  CollectionRequestEvent,
  CollectionsImportRequestEvent,
  CollectionsListRequestEvent,
} from "../../hooks/events";
import { internalRecords } from "../../records/internal";

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;
const INT64_MAX = 2n ** 63n - 1n;

export function requireSuperuser(e: RequestEvent): void {
  if (!e.auth)
    throw new ApiError(
      401,
      "The request requires valid record authorization token.",
    );
  if (e.auth.collection.name !== "_superusers")
    throw new ApiError(
      403,
      "The authorized record is not allowed to perform this action.",
    );
}

function guarded(handler: (e: RequestEvent) => unknown) {
  return (e: RequestEvent) => {
    requireSuperuser(e);
    return handler(e);
  };
}

const picked = (e: RequestEvent, body: Record<string, unknown>) =>
  pickFields(body, e.query.get("fields"));

async function readBody(
  e: RequestEvent,
  message: string,
): Promise<Record<string, unknown>> {
  try {
    return await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, message);
  }
}

function decodeOrFail(
  base: Collection,
  body: Record<string, unknown>,
): Collection {
  try {
    return decodeCollection(base, body);
  } catch (err) {
    if (!(err instanceof DecodeError)) throw err;
    throw new ApiError(
      400,
      "Failed to load the submitted data due to invalid formatting.",
    );
  }
}

function findOr404(app: App, nameOrId: string): Collection {
  const c = app.collections.find(nameOrId);
  if (!c) throw new ApiError(404, "");
  return c;
}

function integer(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  if (!/^[+-]?\d+$/.test(value) || BigInt(value) > INT64_MAX)
    throw new FilterError("invalid number");
  return Number(value);
}

async function save(app: App, input: Collection, action: "create" | "update") {
  try {
    return await app.collections.save(input, action === "create");
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ApiError) throw err;
    throw new ApiError(
      400,
      `Failed to ${action} collection. Raw error: \n${sqliteMessage(err)}`,
    );
  }
}

async function list(e: RequestEvent): Promise<void> {
  const { app, query } = e;
  let page: number;
  let perPage: number;
  let skipTotal: boolean;
  let compiled: ReturnType<typeof compileCollectionsQuery>;
  try {
    page = Math.max(integer(query.get("page"), 1), 1);
    perPage = integer(query.get("perPage"), DEFAULT_PER_PAGE);
    if (perPage < 1) perPage = DEFAULT_PER_PAGE;
    perPage = Math.min(perPage, MAX_PER_PAGE);
    const skip = query.get("skipTotal") ?? "";
    if (!/^(1|t|T|TRUE|true|True|0|f|F|FALSE|false|False|)$/.test(skip))
      throw new FilterError("invalid skipTotal");
    skipTotal = /^(1|t|T|TRUE|true|True)$/.test(skip);
    compiled = compileCollectionsQuery(
      query.get("filter") ?? "",
      query.get("sort") ?? "",
      app.now,
    );
  } catch (err) {
    if (err instanceof FilterError) throw new ApiError(400, "");
    throw err;
  }

  const items = app.collections.search(
    compiled,
    perPage,
    Math.min((page - 1) * perPage, Number.MAX_SAFE_INTEGER),
  );
  const total = skipTotal ? -1 : app.collections.count(compiled);
  const result = {
    page,
    perPage,
    totalItems: total,
    totalPages: skipTotal ? -1 : Math.ceil(total / perPage),
  };
  const hook = app.hooks.onCollectionsListRequest;
  if (hook.length === 0) {
    e.json(
      200,
      markListResult({ ...result, items: items.map(serializeCollection) }),
    );
    return;
  }
  const collections = items.map(apiCollection);
  const event = CollectionsListRequestEvent.from(e, {
    collections,
    result: markListResult({ ...result, items: collections }),
  });
  await hook.trigger(event, (le) => {
    le.json(200, le.result);
  });
}

// The collection of a request event, answered in its API form like PB's Collection.MarshalJSON
// (no token secrets or OAuth2 client secrets).
function apiCollection(c: Collection): Collection {
  return Object.defineProperty({ ...c }, "toJSON", {
    value(this: Collection) {
      return serializeCollection(this);
    },
  });
}

function view(e: RequestEvent): Promise<void> | void {
  const c = findOr404(e.app, e.params.collection!);
  const hook = e.app.hooks.onCollectionViewRequest;
  if (hook.length === 0) {
    e.json(200, serializeCollection(c));
    return;
  }
  const event = CollectionRequestEvent.from(e, {
    collection: apiCollection(c),
  });
  return hook.trigger(event, (ve) => {
    ve.json(200, ve.collection);
  });
}

async function respondSaved(
  e: RequestEvent,
  collection: Collection,
  action: "create" | "update",
): Promise<void> {
  // the spread leaves out the event's toJSON
  const saved = await save(e.app, { ...collection }, action);
  e.json(200, serializeCollection(saved));
}

function saveRequest(
  e: RequestEvent,
  collection: Collection,
  action: "create" | "update",
): Promise<void> {
  const hook =
    action === "create"
      ? e.app.hooks.onCollectionCreateRequest
      : e.app.hooks.onCollectionUpdateRequest;
  if (hook.length === 0) return respondSaved(e, collection, action);
  const event = CollectionRequestEvent.from(e, {
    collection: apiCollection(collection),
  });
  return hook.trigger(event, (se) => respondSaved(se, se.collection, action));
}

async function create(e: RequestEvent): Promise<void> {
  const body = await readBody(
    e,
    "Failed to load the collection type data due to invalid formatting.",
  );
  for (const key of ["type", "name"]) {
    const v = body[key];
    if (v !== undefined && v !== null && typeof v !== "string")
      throw new ApiError(
        400,
        "Failed to load the collection type data due to invalid formatting.",
      );
  }
  const blank = scaffold(
    (body.type || "base") as CollectionType,
    (body.name as string | null | undefined) ?? "",
  );
  const input = decodeOrFail(blank, body);
  if (typeof body.id !== "string" || body.id === "")
    delete (input as Partial<Collection>).id;
  await saveRequest(e, input, "create");
}

async function update(e: RequestEvent): Promise<void> {
  const existing = findOr404(e.app, e.params.collection!);
  const body = await readBody(
    e,
    "Failed to load the submitted data due to invalid formatting.",
  );
  const input = decodeOrFail(existing, body);
  if (input.id !== existing.id) throw new ApiError(404, "");
  await saveRequest(e, input, "update");
}

function remove(e: RequestEvent): Promise<void> {
  const c = findOr404(e.app, e.params.collection!);
  const hook = e.app.hooks.onCollectionDeleteRequest;
  if (hook.length === 0) return removeNow(e, c);
  const event = CollectionRequestEvent.from(e, {
    collection: apiCollection(c),
  });
  return hook.trigger(event, (de) => removeNow(de, de.collection));
}

async function removeNow(e: RequestEvent, c: Collection): Promise<void> {
  try {
    await e.app.collections.delete(c.id);
  } catch {
    const refs = e.app.collections.references(c);
    const suffix =
      refs.length > 0
        ? ` probably due to existing reference in ${refs.map((r) => r.name).join(", ")}`
        : "";
    throw new ApiError(400, `Failed to delete collection${suffix}`);
  }
  e.noContent(204);
}

async function truncate(e: RequestEvent): Promise<Response> {
  const c = findOr404(e.app, e.params.collection!);
  if (c.type === "view")
    throw new ApiError(
      400,
      "View collections cannot be truncated since they don't store their own records.",
    );
  try {
    await internalRecords(e.app, c.name).truncate();
  } catch {
    throw new ApiError(
      400,
      "Failed to truncate collection (most likely due to required cascade delete record references).",
    );
  }
  return new Response(null, { status: 204 });
}

// PB collectionListOAuth2Providers: sorted by order, then by name.
function oauth2Providers(e: RequestEvent): Response {
  const list = Object.values(providers).sort(
    (a, b) => a.order - b.order || (a.name < b.name ? -1 : 1),
  );
  return e.json(
    200,
    list.map(({ name, displayName, logo }) => ({ name, displayName, logo })),
  );
}

function scaffolds(e: RequestEvent): Response {
  const out: Record<string, unknown> = {};
  for (const type of ["base", "auth", "view"] as const) {
    const randomId = newId().slice(0, 10);
    const c = scaffold(type, "", randomId);
    if (type === "auth") {
      c.fields = [idField(), ...authSystemFields()];
      c.indexes = [
        `CREATE UNIQUE INDEX \`idx_tokenKey_${randomId}\` ON \`\` (\`tokenKey\`)`,
        `CREATE UNIQUE INDEX \`idx_email_${randomId}\` ON \`\` (\`email\`) WHERE \`email\` != ''`,
      ];
    }
    c.fields = withDefaults(c.fields);
    c.id = "";
    out[type] = serializeCollection(c);
  }
  return jsonResponse(200, picked(e, out));
}

async function importCollections(e: RequestEvent): Promise<void> {
  const loadError = "An error occurred while loading the submitted data.";
  const body = await readBody(e, loadError);
  const { collections, deleteMissing = false } = body;
  const items = collections ?? [];
  if (
    !Array.isArray(items) ||
    !items.every(
      (i) => i !== null && typeof i === "object" && !Array.isArray(i),
    ) ||
    typeof deleteMissing !== "boolean"
  )
    throw new ApiError(400, loadError);
  if (items.length === 0)
    throw new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      {
        collections: {
          code: "validation_required",
          message: "Cannot be blank.",
        },
      },
    );

  const data = items as Record<string, unknown>[];
  const hook = e.app.hooks.onCollectionsImportRequest;
  if (hook.length === 0) return runImport(e, data, deleteMissing);
  const event = CollectionsImportRequestEvent.from(e, {
    collectionsData: data,
    deleteMissing,
  });
  // like PB, the submitted deleteMissing and not the event's
  await hook.trigger(event, (ie) =>
    runImport(ie, ie.collectionsData, deleteMissing),
  );
}

async function runImport(
  e: RequestEvent,
  data: Record<string, unknown>[],
  deleteMissing: boolean,
): Promise<void> {
  try {
    await e.app.collections.import(data, deleteMissing);
  } catch (err) {
    if (err instanceof ValidationError)
      throw new ApiError(400, "Failed to import collections.", err.data);
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, "Failed to import collections.", {
      collections: {
        code: "validation_collections_import_failure",
        message:
          "Failed to import the collections configuration. Raw error:\n" +
          sqliteMessage(err),
      },
    });
  }
  e.noContent(204);
}

async function dryRunViewQuery(e: RequestEvent): Promise<Response> {
  const loadError = "An error occurred while loading the submitted data.";
  const body = await readBody(e, loadError);
  const query = body.query ?? "";
  if (typeof query !== "string") throw new ApiError(400, loadError);
  const invalid = (data: Record<string, unknown>) =>
    new ApiError(
      400,
      "An error occurred while validating the submitted data.",
      {
        query: data,
      },
    );
  if (query === "")
    throw invalid({ code: "validation_required", message: "Cannot be blank." });
  if ([...query].length > 5000)
    throw invalid({
      code: "validation_length_too_long",
      message: "The length must be no more than 5000.",
      params: { max: 5000, min: 0 },
    });
  try {
    const app = e.app;
    return e.json(
      200,
      await app.db.write(() => dryRunView(app.db, app.collections, query, 10)),
    );
  } catch (err) {
    throw new ApiError(
      400,
      `Invalid view query. Raw error: \n${sqliteMessage(err)}`,
    );
  }
}

export function registerCollectionRoutes(router: Router): void {
  router.route("GET", "/api/collections", guarded(list));
  router.route("POST", "/api/collections", guarded(create));
  router.route("GET", "/api/collections/{collection}", guarded(view));
  router.route("PATCH", "/api/collections/{collection}", guarded(update));
  router.route("DELETE", "/api/collections/{collection}", guarded(remove));
  router.route(
    "DELETE",
    "/api/collections/{collection}/truncate",
    guarded(truncate),
  );
  router.route("PUT", "/api/collections/import", guarded(importCollections));
  router.route("GET", "/api/collections/meta/scaffolds", guarded(scaffolds));
  router.route(
    "GET",
    "/api/collections/meta/oauth2-providers",
    guarded(oauth2Providers),
  );
  router.route(
    "POST",
    "/api/collections/meta/dry-run-view",
    guarded(dryRunViewQuery),
  );
}
