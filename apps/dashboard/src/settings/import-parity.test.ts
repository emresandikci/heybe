import type { CollectionModel } from "@heybe/client";
import { expect, test } from "bun:test";
import type { App } from "../../../../packages/heybe/src/app";
import { serializeCollection } from "../../../../packages/heybe/src/collections/codec";
import { testApp } from "../../../../packages/heybe/src/test-app";
import { diffImport, type ImportDiff } from "./import-diff";

type C = CollectionModel;
type F = Record<string, unknown>;

const snapshot = (app: App): C[] =>
  JSON.parse(JSON.stringify(app.collections.all().map(serializeCollection)));

const stable = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

const props = ({ id: _i, created: _c, updated: _u, fields: _f, ...rest }: C) =>
  stable(rest);

function fieldChanges(before: F[], after: F[]) {
  const diff = {
    added: [] as string[],
    changed: [] as string[],
    deleted: [] as string[],
  };
  for (const f of after) {
    const old = before.find((x) => x.id === f.id);
    if (!old) diff.added.push(String(f.name));
    else if (old.name !== f.name)
      diff.changed.push(`${String(old.name)} -> ${String(f.name)}`);
    else if (stable(old) !== stable(f)) diff.changed.push(String(f.name));
  }
  for (const f of before)
    if (!after.some((x) => x.id === f.id)) diff.deleted.push(String(f.name));
  return diff;
}

// What the server import really did, compared by collection and field ids.
function actualDiff(before: C[], after: C[]): ImportDiff {
  const diff: ImportDiff = { added: [], changed: [], deleted: [] };
  for (const a of after)
    if (!before.some((b) => b.id === a.id)) diff.added.push(a.name);
  for (const b of before) {
    const a = after.find((x) => x.id === b.id);
    if (!a) {
      if (!b.system) diff.deleted.push(b.name);
      continue;
    }
    // view fields are rebuilt from viewQuery and hold no data
    const fields =
      a.type === "view"
        ? { added: [], changed: [], deleted: [] }
        : fieldChanges(b.fields, a.fields);
    const touched =
      fields.added.length + fields.changed.length + fields.deleted.length > 0;
    if (touched || props(a) !== props(b))
      diff.changed.push(
        a.name === b.name
          ? { name: a.name, fields }
          : { name: a.name, previousName: b.name, fields },
      );
  }
  return diff;
}

const strip = ({ created: _c, updated: _u, ...rest }: C) => rest as C;
const noIds = (c: C) =>
  ({ ...strip(c), fields: c.fields.map(({ id: _, ...f }) => f) }) as C;
const posts = (cur: C[]) => cur.find((c) => c.name === "posts")!;
const mapFields = (c: C, fn: (f: F) => F | null) =>
  ({ ...c, fields: c.fields.map(fn).filter((f) => f !== null) }) as C;

async function withPosts(app: App) {
  await app.collections.save({
    name: "posts",
    fields: [
      { name: "title", type: "text" },
      { name: "body", type: "text" },
      { name: "n", type: "number" },
    ],
  } as never);
}

async function renamedThenReadded(app: App) {
  await withPosts(app);
  const c = app.collections.find("posts")!;
  await app.collections.save({
    ...c,
    fields: c.fields.map((f) =>
      f.name === "title" ? { ...f, name: "headline" } : f,
    ),
  } as never);
  const c2 = app.collections.find("posts")!;
  await app.collections.save({
    ...c2,
    fields: [...c2.fields, { name: "title", type: "text" }],
  } as never);
}

const cases: {
  name: string;
  setup?: (app: App) => Promise<void>;
  make: (cur: C[]) => Partial<C>[];
  failsWithoutDeleteMissing?: true;
}[] = [
  {
    name: "rename a field by id",
    make: (cur) => [
      mapFields(strip(posts(cur)), (f) =>
        f.name === "body" ? { ...f, name: "content" } : f,
      ),
    ],
  },
  { name: "fields without ids", make: (cur) => [noIds(posts(cur))] },
  {
    name: "field without id changes type",
    make: (cur) => [
      mapFields(noIds(posts(cur)), (f) =>
        f.name === "n" ? { name: "n", type: "text" } : f,
      ),
    ],
    failsWithoutDeleteMissing: true,
  },
  {
    name: "drop a field",
    make: (cur) => [
      mapFields(strip(posts(cur)), (f) => (f.name === "body" ? null : f)),
    ],
  },
  {
    name: "change a field option",
    make: (cur) => [
      mapFields(strip(posts(cur)), (f) =>
        f.name === "title" ? { ...f, required: true } : f,
      ),
    ],
  },
  {
    name: "only non-system fields",
    make: (cur) => [mapFields(strip(posts(cur)), (f) => (f.system ? null : f))],
  },
  { name: "no fields key", make: () => [{ name: "posts" }] },
  {
    name: "rename onto a left-out field's name",
    make: (cur) => [
      mapFields(strip(posts(cur)), (f) =>
        f.name === "title"
          ? null
          : f.name === "body"
            ? { ...f, name: "title" }
            : f,
      ),
    ],
  },
  {
    name: "renamed field whose old name was added again, no ids",
    setup: renamedThenReadded,
    make: (cur) => [noIds(posts(cur))],
  },
  {
    name: "rename the collection and add one",
    make: (cur) => [
      { ...strip(posts(cur)), name: "articles", listRule: "" },
      { name: "tags", type: "base" },
    ],
  },
  {
    name: "other collections missing",
    setup: async (app) => {
      await withPosts(app);
      await app.collections.save({ name: "tags" } as never);
    },
    make: (cur) => [strip(posts(cur))],
  },
  {
    name: "view collection without field ids",
    setup: async (app) => {
      await withPosts(app);
      await app.collections.save({
        name: "v",
        type: "view",
        viewQuery: "select id, title from posts",
      } as never);
    },
    make: (cur) => [strip(posts(cur)), noIds(cur.find((c) => c.name === "v")!)],
  },
];

for (const deleteMissing of [false, true])
  for (const c of cases)
    test(`diffImport matches the server import: ${c.name}, deleteMissing ${deleteMissing}`, async () => {
      const app = testApp();
      try {
        await (c.setup ?? withPosts)(app);
        const before = snapshot(app);
        const incoming = c.make(before);
        const predicted = diffImport(
          before,
          JSON.parse(JSON.stringify(incoming)),
          deleteMissing,
        );
        const run = app.collections.import(incoming as never, deleteMissing);
        if (c.failsWithoutDeleteMissing && !deleteMissing) {
          expect(predicted.changed[0]!.fields.added).toEqual(["n"]);
          await expect(run).rejects.toThrow();
          return;
        }
        await run;
        expect(predicted).toEqual(actualDiff(before, snapshot(app)));
      } finally {
        app.close();
      }
    });
