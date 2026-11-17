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
6. **Operations:** rate limiting, logs, backups, S3, SQL API.
7. **Dashboard**
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

## Single binary

Build one executable that embeds the dashboard and the sharp native files (needs Bun 1.4 and a prior `pnpm install`):

```bash
cd packages/heybe
bun scripts/build-binary.ts          # writes dist/heybe for this machine
bun scripts/smoke-binary.ts --binary dist/heybe
./dist/heybe serve
```

`--target bun-linux-x64` (or `bun-linux-arm64`, `bun-darwin-arm64`) builds for another platform; build on a matching machine so sharp's native package fits. The thumbnail libraries are extracted to the temp directory on first use.

`heybe serve example.com` serves HTTPS with a Let's Encrypt certificate (HTTP-01). Port 80 and 443 must be reachable from the internet. The certificate is cached in `<dir>/.autocert_cache`.

## Migrating from PocketBase

Stop PocketBase, then import its data directory into a fresh Heybe one:

```bash
heybe import ./pb_data --dir ./heybe_data [--encryptionEnv PB_KEY]
```

Imported: collections (with their rules, indexes and auth token secrets, so issued tokens stay valid), all records, settings and uploaded files (not when PocketBase uses S3). Not imported: logs, backups, migration history, `pb_hooks` and `pb_migrations`. Port hooks and migrations by hand. `--encryptionEnv` names the environment variable that holds the key when PocketBase settings are encrypted.

## npm

The packages are not published yet. Once they are, `heybe` runs on Bun only:

```bash
bun add heybe
bunx heybe serve
```

## Dashboard

The superuser panel lives in `apps/dashboard` (React, Vite) and is served by `heybe serve` at `/_/` once it is built. It talks to the server only through `@heybe/client`.

```bash
pnpm --filter @heybe/dashboard build
```

The build writes `packages/heybe/ui/dist`. Without it the server does not register `/_/`. For development run `heybe serve` on 8090 and `pnpm --filter @heybe/dashboard dev`.

Record previews block remote images (the dashboard CSP allows none, like PocketBase).

Email templates are written in MJML and compiled in the browser (`mjml-browser`, loaded on demand). The server stores the HTML with the MJML source embedded as a trailing `<!-- heybe:mjml:<base64> -->` comment.

Tests:

```bash
pnpm --filter @heybe/dashboard test
pnpm --filter @heybe/dashboard exec playwright install chromium   # once
pnpm test:e2e
```

Extensions add pages and links to the panel. Register a directory in `onServe` and put a `main.js` in it:

```ts
app.onServe((e) => {
  e.uiExtensions.push({ name: "demo", dir: "./ui-extensions/demo" });
  return e.next();
});
```

```js
window.heybe.dashboard.addPage({
  path: "demo",
  title: "Demo",
  mount(el, { client }) {
    el.textContent = "Demo extension for " + client.authStore.record.email;
  },
});
```

An extension can build its page with the dashboard components from `@heybe/ui`. Install `react`, `react-dom` and `@heybe/ui` in the extension, bundle it, and render with your own root:

```tsx
import { createRoot } from "react-dom/client";
import { Button } from "@heybe/ui";
import "@heybe/ui/style.css";

window.heybe.dashboard.addPage({
  path: "demo",
  title: "Demo",
  mount(el) {
    const root = createRoot(el);
    root.render(<Button>Hello</Button>);
    return () => root.unmount();
  },
});
```

## License

[MIT](LICENSE)

Heybe is an independent project and is not affiliated with or endorsed by PocketBase or its author.
