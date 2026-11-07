import type { App } from "../../app";
import { decodeCollection, serializeCollection } from "../../collections/codec";
import { sqliteMessage } from "../../collections/ddl";
import { DecodeError, withDefaults } from "../../collections/field-settings";
import { type Collection, type CollectionType } from "../../collections/model";
import { compileCollectionsQuery } from "../../collections/search";
import {
  authSystemFields,
  idField,
  scaffold,
} from "../../collections/scaffold";
import { FilterError } from "../../filter/parse";
import { pickFields } from "../../records/serialize";
import { ValidationError, newId } from "../../util";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 1000;
const INT64_MAX = 2n ** 63n - 1n;

function requireSuperuser(e: RequestEvent): void {
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

function guarded(handler: (e: RequestEvent) => Response | Promise<Response>) {
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

function save(app: App, input: Collection, action: "create" | "update") {
  try {
    return app.collections.save(input, action === "create");
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ApiError) throw err;
    throw new ApiError(
      400,
      `Failed to ${action} collection. Raw error: \n${sqliteMessage(err)}`,
    );
  }
}

function list(e: RequestEvent): Response {
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
  return e.json(200, {
    page,
    perPage,
    totalItems: total,
    totalPages: skipTotal ? -1 : Math.ceil(total / perPage),
    items: items.map((c) => picked(e, serializeCollection(c))),
  });
}

async function create(e: RequestEvent): Promise<Response> {
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
  return e.json(
    200,
    picked(e, serializeCollection(save(e.app, input, "create"))),
  );
}

async function update(e: RequestEvent): Promise<Response> {
  const existing = findOr404(e.app, e.params.collection!);
  const body = await readBody(
    e,
    "Failed to load the submitted data due to invalid formatting.",
  );
  const input = decodeOrFail(existing, body);
  if (input.id !== existing.id) throw new ApiError(404, "");
  return e.json(
    200,
    picked(e, serializeCollection(save(e.app, input, "update"))),
  );
}

function remove(e: RequestEvent): Response {
  const c = findOr404(e.app, e.params.collection!);
  try {
    e.app.collections.delete(c.id);
  } catch {
    const refs = e.app.collections.references(c);
    const suffix =
      refs.length > 0
        ? ` probably due to existing reference in ${refs.map((r) => r.name).join(", ")}`
        : "";
    throw new ApiError(400, `Failed to delete collection${suffix}`);
  }
  return new Response(null, { status: 204 });
}

function truncate(e: RequestEvent): Response {
  const c = findOr404(e.app, e.params.collection!);
  if (c.type === "view")
    throw new ApiError(
      400,
      "View collections cannot be truncated since they don't store their own records.",
    );
  try {
    e.app.records(c.name).truncate();
  } catch {
    throw new ApiError(
      400,
      "Failed to truncate collection (most likely due to required cascade delete record references).",
    );
  }
  return new Response(null, { status: 204 });
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
  return e.json(200, picked(e, out));
}

async function importCollections(e: RequestEvent): Promise<Response> {
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

  try {
    e.app.collections.import(items as Record<string, unknown>[], deleteMissing);
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
  return new Response(null, { status: 204 });
}

export function registerCollectionRoutes(router: Router): void {
  router.add("GET", "/api/collections", guarded(list));
  router.add("POST", "/api/collections", guarded(create));
  router.add(
    "GET",
    "/api/collections/{collection}",
    guarded((e) =>
      e.json(
        200,
        picked(e, serializeCollection(findOr404(e.app, e.params.collection!))),
      ),
    ),
  );
  router.add("PATCH", "/api/collections/{collection}", guarded(update));
  router.add("DELETE", "/api/collections/{collection}", guarded(remove));
  router.add(
    "DELETE",
    "/api/collections/{collection}/truncate",
    guarded(truncate),
  );
  router.add("PUT", "/api/collections/import", guarded(importCollections));
  router.add("GET", "/api/collections/meta/scaffolds", guarded(scaffolds));
}
