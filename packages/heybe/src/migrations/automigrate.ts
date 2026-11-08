import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app";
import { decodeCollection, serializeCollection } from "../collections/codec";
import type { Collection, CollectionType, Field } from "../collections/model";
import { scaffold } from "../collections/scaffold";
import type { CollectionRequestEvent } from "../hooks/events";
import { createMigrationsTable } from "./runner";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

const canonical = (v: unknown) => JSON.stringify(sortKeys(v));

// PB marhshalWithoutEscape(v, "  ", "  "): sorted keys, 2-space indent, every line after the first
// prefixed with 2 spaces
const marshal = (v: unknown) =>
  JSON.stringify(sortKeys(v), null, 2).replaceAll("\n", "\n  ");

const quote = (s: string) => JSON.stringify(s);

function toMap(c: Collection): Obj {
  const data = JSON.parse(JSON.stringify(serializeCollection(c))) as Obj;
  delete data.created;
  delete data.updated;
  if (isObj(data.oauth2)) delete data.oauth2.providers;
  return data;
}

// Port of PB plugins/migratecmd/templates.go diffMaps
function diffMaps(old: Obj, next: Obj, exclude: string[] = []): Obj {
  const diff: Obj = {};
  for (const [k, vNew] of Object.entries(next)) {
    if (exclude.includes(k)) continue;
    if (!Object.hasOwn(old, k)) {
      diff[k] = vNew;
      continue;
    }
    const vOld = old[k];
    if (canonical(vOld) === canonical(vNew)) continue;
    if (isObj(vOld) && isObj(vNew)) {
      const sub = diffMaps(vOld, vNew);
      if (Object.keys(sub).length > 0) diff[k] = sub;
    } else diff[k] = vNew;
  }
  for (const k of Object.keys(old))
    if (
      !Object.hasOwn(diff, k) &&
      !exclude.includes(k) &&
      !Object.hasOwn(next, k)
    )
      diff[k] = null;
  return diff;
}

function source(helpers: string[], up: string, down: string): string {
  const names = ["migrate", ...helpers].sort().join(", ");
  return `import { ${names} } from "heybe";

export default migrate(async (app) => {
  ${up}
}, async (app) => {
  ${down}
});
`;
}

const saveNew = (
  data: Obj,
) => `const collection = newCollection(${marshal(data)});

  await app.collections.save(collection, true);`;

const deleteById = (id: string) =>
  `await app.collections.delete(${quote(id)});`;

// Port of PB jsDiffTemplate in Heybe's TS format; "" when nothing changed.
function diffTemplate(next: Collection | null, old: Collection | null): string {
  if (!next)
    return source(["newCollection"], deleteById(old!.id), saveNew(toMap(old!)));
  if (!old)
    return source(["newCollection"], saveNew(toMap(next)), deleteById(next.id));

  const up: string[] = [];
  const down: string[] = [];
  const helpers = new Set<string>();
  const newMap = toMap(next);
  const oldMap = toMap(old);
  const exclude = ["fields", "created", "updated"];

  const upDiff = diffMaps(oldMap, newMap, exclude);
  if (Object.keys(upDiff).length > 0) {
    const downDiff = diffMaps(newMap, oldMap, exclude);
    helpers.add("mergeCollection");
    up.push(
      "// update collection data",
      `mergeCollection(collection, ${marshal(upDiff)});\n`,
    );
    down.push(
      "// update collection data",
      `mergeCollection(collection, ${marshal(downDiff)});\n`,
    );
  }

  const oldFields = oldMap.fields as Obj[];
  const newFields = newMap.fields as Obj[];
  const addAt = (i: number, f: Obj) =>
    `addFieldAt(collection, ${i}, ${marshal(f)});\n`;
  const removeById = (id: unknown) =>
    `removeFieldById(collection, ${quote(String(id))});\n`;

  oldFields.forEach((f, i) => {
    if (newFields.some((n) => n.id === f.id)) return;
    helpers.add("removeFieldById").add("addFieldAt");
    up.push("// remove field", removeById(f.id));
    down.push("// add field", addAt(i, f));
  });

  newFields.forEach((f, i) => {
    if (oldFields.some((o) => o.id === f.id)) return;
    helpers.add("removeFieldById").add("addFieldAt");
    up.push("// add field", addAt(i, f));
    down.push("// remove field", removeById(f.id));
  });

  // like PB, order-only changes are ignored
  newFields.forEach((f, i) => {
    const j = oldFields.findIndex((o) => o.id === f.id);
    if (j < 0 || canonical(oldFields[j]) === canonical(f)) return;
    helpers.add("addFieldAt");
    up.push("// update field", addAt(i, f));
    down.push("// update field", addAt(j, oldFields[j]!));
  });

  if (up.length === 0) return "";

  const body = (
    id: string,
    parts: string[],
  ) => `const collection = app.collections.require(${quote(id)});

  ${parts.join("\n  ").trim()}

  await app.collections.save(collection);`;
  return source([...helpers], body(old.id, up), body(next.id, down));
}

export function snapshotTemplate(collections: Collection[]): string {
  return `import { importCollections, migrate } from "heybe";

export default migrate(async (app) => {
  const snapshot = ${marshal(collections.map(toMap))};

  await importCollections(app, snapshot, false);
}, async () => {});
`;
}

// PB normalizeCollectionName: a name ending in "test" gets a trailing "_"
const normalizeName = (name: string) =>
  name.toLowerCase().endsWith("test") ? `${name}_` : name;

async function onCollectionChange(
  e: CollectionRequestEvent,
  isNew: boolean,
): Promise<void> {
  const { app } = e;
  const old = isNew ? null : app.collections.find(e.collection.id);
  await e.next();
  const next = e.collection.id ? app.collections.find(e.collection.id) : null;
  if (!old && !next) return;

  const template = diffTemplate(next, old);
  if (template === "") return;

  const action = !next
    ? `deleted_${normalizeName(old!.name)}`
    : !old
      ? `created_${normalizeName(next.name)}`
      : `updated_${normalizeName(old.name)}`;
  const now = app.now().getTime();
  const name = `${Math.floor(now / 1000)}_${action}.ts`;
  await app.db.write(() => {
    createMigrationsTable(app);
    app.db.run("INSERT INTO _migrations (file, applied) VALUES (?, ?)", [
      name,
      now * 1000,
    ]);
    mkdirSync(app.migrationsDir, { recursive: true });
    writeFileSync(join(app.migrationsDir, name), template);
  });
}

// Port of PB plugins/migratecmd/automigrate.go
export function bindAutomigrate(app: App): void {
  app.hooks.onCollectionCreateRequest.bind((e) => onCollectionChange(e, true));
  app.hooks.onCollectionUpdateRequest.bind((e) => onCollectionChange(e, false));
  app.hooks.onCollectionDeleteRequest.bind((e) => onCollectionChange(e, false));
}

// PB `new Collection(data)`: the scaffold of the type with the data merged on top
export function newCollection(data: Obj): Collection {
  return decodeCollection(
    scaffold(
      (data.type ?? "base") as CollectionType,
      String(data.name ?? ""),
      typeof data.id === "string" ? data.id : undefined,
    ),
    data,
  );
}

function merge(target: Obj, patch: Obj): void {
  for (const [k, v] of Object.entries(patch)) {
    const current = target[k];
    if (isObj(v) && isObj(current)) merge(current, v);
    else target[k] = v;
  }
}

// PB unmarshal of a diff: nested objects merge, other values (null included) replace
export function mergeCollection(c: Collection, patch: Obj): void {
  merge(c, patch);
}

export function removeFieldById(c: Collection, id: string): void {
  c.fields = c.fields.filter((f) => f.id !== id);
}

// PB FieldsList.AddAt
export function addFieldAt(c: Collection, index: number, field: Obj): void {
  removeFieldById(c, String(field.id));
  c.fields.splice(Math.min(index, c.fields.length), 0, field as Field);
}
