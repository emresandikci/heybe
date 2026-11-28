---
name: heybe
description: Build apps on Heybe, a single-binary backend with a dashboard, REST API, realtime and a typed client. Use when working in a project that uses Heybe (hb_hooks, hb_migrations, @heybejs/core, @heybejs/client, @heybejs/query, filters, API rules, heybe serve, heybe import).
---

# Heybe

Heybe is one binary (`heybe`) that serves a SQLite-backed REST API, realtime (SSE), file storage, auth and a dashboard at `/_/`. Hooks, routes, cron jobs and migrations are TypeScript or JavaScript files that the binary loads with no build step. Docs: https://emresandikci.github.io/heybe/

npm packages: `@heybejs/client`, `@heybejs/query`, `@heybejs/core`, `@heybejs/ui`.

## Project layout

```
hb_data/         database and uploaded files (managed by Heybe, never edit by hand)
hb_hooks/        hooks, routes, cron jobs, console commands
hb_migrations/   migration files
hb-env.d.ts      collection types, written by `heybe typegen`
```

```bash
heybe serve                 # API at 127.0.0.1:8090/api/, dashboard at /_/
heybe typegen               # write hb-env.d.ts (--out sets another path)
heybe superuser upsert admin@example.com 'a-long-password'
```

`--dir`, `--hooksDir` and `--migrationsDir` move the three directories. `heybe serve --dev` prints logs and SQL and rewrites `hb-env.d.ts` when collections change. Commands: `serve`, `superuser`, `migrate`, `import`, `typegen`.

Docs: https://emresandikci.github.io/heybe/getting-started

## Hooks and routes

Every file in `hb_hooks` default-exports a function that receives the app. Files run in file name order; `.d.ts` and `.test.ts` files are skipped. A file that throws stops the start.

For editor types only, run `bun add -d @heybejs/core`. The binary uses its embedded copy at runtime.

Function form:

```ts
// hb_hooks/hello.ts
export default (app) => {
  app.onRecordCreate("posts", async (e) => e.next());
  app.get("/hello/{name}", (e) => e.json(200, { name: e.params.name }));
};
```

Class form:

```ts
import { RecordHooks, Route } from "@heybejs/core";

class PostHooks extends RecordHooks {
  collection = "posts";
  async onCreate(e) {
    e.record.set("slug", slugify(e.record.get("title")));
    return e.next();
  }
}

class HelloRoute extends Route {
  method = "GET";
  path = "/hello/{name}";
  async handle(e) {
    return e.json(200, { message: `Hello ${e.params.name}` });
  }
}

export default (app) => app.register(PostHooks, HelloRoute);
```

- Call `e.next()` to continue the chain and the default behavior. Not calling it stops the chain.
- `RecordHooks` method names drop `Record`: `onValidate`, `onCreate`, `onAfterCreateSuccess`, `onUpdate`, `onDelete`, `onEnrich`, `onListRequest`, and so on. `priority` orders handlers.
- Router: `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `any`, `group`, `use`. Path params are `{name}`, read from `e.params`.
- Guards: `requireAuth(...collections)`, `requireSuperuserAuth()`, `requireSuperuserOrOwnerAuth()` from `@heybejs/core`.

```ts
export default (app) => {
  const api = app.group("/api/my").use(requireAuth());
  api.get("/ping", (e) => e.json(200, { ok: true }));
  app.command("hello", () => console.log("hello"), {
    description: "Say hello",
  });
};
```

Docs: https://emresandikci.github.io/heybe/hooks-and-routes

## Queries

`@heybejs/query` turns objects into filter, sort and expand strings. The client and server code (`app.records("posts")`) share it.

```ts
await heybe.records("posts").findMany({
  where: {
    status: form.status,
    views: { gt: 50 },
    OR: [{ title: { like: form.search } }, { tags: { anyLike: form.tag } }],
  },
  orderBy: { created: "desc" },
  expand: { author: true },
  page: 1,
  perPage: 30,
});
```

- A plain value means equal. Several keys are ANDed; `AND` and `OR` take arrays.
- `undefined`, `null`, empty `AND`/`OR` and non-finite numbers produce no condition, so form inputs can be passed directly.
- Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `notLike`, the `any*` versions for multi-value fields, `insensitive: true`, `length`, `each`, `empty`.
- On multi-value fields (`select` with `maxSelect > 1`, `relation`, `file`) use `each`: `tags: { each: { anyEq: "x" } }`.
- `count: false` skips counting (`totalItems` is `-1`). Back-relations expand as `comments_via_post`.
- Raw strings for user-typed filters: `findMany({ filter: 'title ~ "news"', sort: "-created" })`. They are joined with the generated ones.

Docs: https://emresandikci.github.io/heybe/queries

## Client

```bash
npm install @heybejs/client @heybejs/query
```

`@heybejs/query` is a peer dependency: the app and the client must share one copy. Keep `hb-env.d.ts` inside the tsconfig `include` so `where`, `orderBy` and `expand` are typed.

```ts
import { createClient } from "@heybejs/client";

const heybe = createClient("http://127.0.0.1:8090");
const posts = heybe.records("posts");

const page = await posts.findMany({ where: { status: "published" } });
const post = await posts.findOne("RECORD_ID", { expand: { author: true } });
const first = await posts.findFirst({ where: { slug: "hello" } }); // 404 HeybeError if none
await posts.create({ title: "Hello", cover: new File([bytes], "cover.png") });
await posts.update(post.id, { title: "Renamed", "tags+": "new" });
await posts.delete(post.id);

await heybe.auth("users").withPassword("a@example.com", "secret");
heybe.authStore.record;
```

- Auth: `methods`, `withPassword`, `requestOTP` and `withOTP`, `withOAuth2`, `refresh`, `impersonate`. Every success saves to `heybe.authStore` (localStorage in browsers, memory elsewhere).
- Files: send a `File` value and the client uses multipart. `heybe.files.url(record, filename, { thumb: "100x100" })`. Protected fields need `await heybe.files.token()`.
- Requests with the same key (`METHOD + path`) auto-cancel the pending one. Pass `requestKey: null` to opt out.

Realtime:

```ts
const unsubscribe = await posts.subscribe("*", ({ action, record }) => {}, {
  where: { status: "published" },
});
await unsubscribe();

await heybe.realtime.subscribe("HB_CONNECT", ({ clientId }) => {});
```

`"*"` is the whole collection, a record id is one record. `action` is `create`, `update` or `delete`. Events only reach clients whose auth may read the record under the collection rules. The client reconnects and resubscribes on its own.

Docs: https://emresandikci.github.io/heybe/client , https://emresandikci.github.io/heybe/realtime , https://emresandikci.github.io/heybe/files

## Collections and API rules

Collection types: `base`, `auth`, `view` (read-only SQL `SELECT`). Each collection has `listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`:

| Value      | Meaning                             |
| ---------- | ----------------------------------- |
| `null`     | Locked, superusers only             |
| `""`       | Open to everyone, signed in or not  |
| expression | Allowed when the expression is true |

Superusers skip every rule. A record that fails a view, update or delete rule returns 404.

```
listRule:   @request.auth.id != "" && owner = @request.auth.id
updateRule: owner = @request.auth.id && @request.body.owner:isset = false
```

- Operators: `=` `!=` `>` `>=` `<` `<=` `~` `!~`, the `?` versions for multi-value fields, `&&`, `||`, parentheses.
- Variables: `@request.auth.*`, `@request.body.*`, `@request.query.*`, `@request.headers.*`, `@request.method`, `@request.context`, `@collection.<name>.*`.
- Modifiers: `:isset`, `:changed`, `:length`, `:each`, `:lower`.
- Date macros (UTC): `@now`, `@todayStart`, `@todayEnd`, `@monthStart`, `@yearStart`, and others.
- Changing a collection in the dashboard or API writes a migration file to `hb_migrations` (`--automigrate=false` turns this off).

Docs: https://emresandikci.github.io/heybe/collections-and-rules

## Migrations, cron and typegen

```ts
// hb_migrations/1700000000_add_slug.ts
import { migrate } from "@heybejs/core";

export default migrate(
  async (app) => {}, // up
  async (app) => {}, // down
);
```

```bash
heybe migrate create add_slug   # new <unix time>_add_slug.ts
heybe migrate up                # run pending (serve also applies them on start)
heybe migrate down 1            # revert the last N
heybe migrate collections       # snapshot of the current collections
heybe migrate history-sync      # drop history entries of deleted files
```

Commit the generated migration files so other environments apply them. Helpers from `@heybejs/core`: `newCollection`, `mergeCollection`, `addFieldAt`, `removeFieldById`, `importCollections`.

Cron, registered in `hb_hooks`:

```ts
export default (app) => {
  app.cron("0 3 * * *", async () => {});
  app.cron("cleanup", "*/10 * * * *", async (app) => {});
};
```

Schedules have five fields (minute, hour, day of month, month, day of week) or a macro such as `@hourly`. Class form: extend `Cron` with `schedule` and `run(app)`.

Docs: https://emresandikci.github.io/heybe/cron-and-migrations

## Importing a PocketBase project

```bash
heybe import ./pb_data --dir ./hb_data
```

Needs PocketBase v0.23 or newer data. Add `--encryptionEnv PB_KEY` if settings are encrypted. Logs, backups, migration history, `pb_hooks` and `pb_migrations` are not imported: port hooks and migrations by hand.

Docs: https://emresandikci.github.io/heybe/migrating-from-pocketbase

## Common mistakes

- Using PocketBase names: the directories are `hb_hooks`, `hb_migrations` and `hb_data`, not `pb_hooks`, `pb_migrations` or `pb_data`. Collection ids start with `hbc_`, not `pbc_`.
- Writing hooks as global-style scripts (`routerAdd`, `$app`). Hooks here are files that default-export a function taking the app.
- Using `anyEq` or `tags?=` on the multi-value field itself. It matches nothing. Use `each`.
- Hardcoding collection ids. Use collection names.
- Editing `hb_data` by hand. Change collections in the dashboard or API, or with a migration.
- Forgetting `e.next()` in a hook, which stops the chain and the default behavior.
- Passing `null` for a rule when you meant open. `null` is locked, `""` is open.
- Installing `@heybejs/client` without `@heybejs/query`. It is a peer dependency and must be one shared copy.
