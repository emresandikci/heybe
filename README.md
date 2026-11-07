# Heybe

Heybe is an open source backend in a single binary, built with TypeScript on [Bun](https://bun.sh). It brings the feature set of [PocketBase](https://ganigeorgiev.com/pocketbase/pocketbase) to the JavaScript ecosystem, so you can extend and read it without leaving TypeScript.

> **Status:** early development. Nothing is usable yet. The API below is the planned design and may change.

## Goals

- **PocketBase compatible HTTP API** (based on v0.41.1), so existing apps can switch by changing the URL.
- **Fast.** Bun, built-in SQLite, prepared statement caching and no heavy layers. Response times should be on par with PocketBase or better.
- **Extend with classes or functions**, in plain TypeScript or JavaScript, no build step and no decorators.
- **One type-safe query syntax** shared by the server and the frontend.
- **Own client** (`@heybe/client`) with auth, realtime, files and queries behind one typed API.
- **New dashboard** for collections, records and settings.
- **Own storage format** with `heybe import` to migrate from an existing `pb_data`.

## Planned API

### Hooks and routes

```ts
import { RecordHooks, Route } from "heybe";

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

app.register(PostHooks, HelloRoute);

// or with functions
app.onRecordCreate("posts", async (e) => e.next());
app.get("/hello/{name}", (e) => e.json(200, { message: "Hello" }));
```

### Queries

The same syntax works on the server and in the frontend. Types are generated from your collection schema.

```ts
const posts = await heybe.records("posts").findMany({
  where: {
    status: form.status, // skipped when undefined
    comments: { gt: 50 },
    OR: [{ title: { like: form.search } }, { tags: { anyLike: form.tag } }],
  },
  orderBy: { created: "desc" },
  expand: { author: true },
  page: 1,
  perPage: 30,
});
```

## Roadmap to 1.0

1. **Core:** HTTP server, storage, base and auth collections, all field types, record CRUD, filter language, API rules, `@heybe/query`, superusers, password auth, settings.
2. **Relations and files:** expand, back-relations, indexes, view collections, batch API, file uploads, thumbnails, protected files, type generation.
3. **Auth:** mail and templates, verification, password reset, email change, OAuth2, OTP, MFA, impersonation.
4. **Extending and realtime:** hooks, routes, middleware, cron, migrations, console commands, realtime (SSE).
5. **`@heybe/client`**
6. **Dashboard**
7. **Operations:** rate limiting, logs, backups, S3, SQL API.
8. **Distribution:** `heybe import`, single binary, npm package, docs.

## Development

Requirements: Node.js 24 and pnpm 10 for the tooling, Bun 1.4 for the runtime.

```bash
pnpm install
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org). Direct `git commit` is blocked, use:

```bash
pnpm commit
```

Each package is versioned and released on its own with semantic-release when changes land on `main`.

## License

[MIT](LICENSE)

Heybe is an independent project and is not affiliated with or endorsed by PocketBase or its author.
