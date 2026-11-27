<p><img src="docs/assets/logo.svg" width="64" height="64" alt=""></p>

# Heybe

Heybe is an open source backend in a single binary, built with TypeScript on [Bun](https://bun.sh). It brings the feature set of [PocketBase](https://pocketbase.io) to the JavaScript ecosystem, so you can extend and read it without leaving TypeScript.

> **Status:** the npm packages and the Docker image are not published yet. Use the binaries from GitHub Releases.

- **PocketBase compatible HTTP API** (based on v0.41.1), so existing apps can switch by changing the URL.
- **Fast.** Bun, built-in SQLite, prepared statement caching and no heavy layers. Response times should be on par with PocketBase or better.
- **Extend with classes or functions**, in plain TypeScript or JavaScript, no build step and no decorators.
- **One type-safe query syntax** shared by the server and the frontend.
- **Own client** (`@heybejs/client`) with auth, realtime, files and queries behind one typed API.
- **New dashboard** for collections, records and settings.
- **Own storage format** with `heybe import` to migrate from an existing `pb_data`.

## Quick start

Get the archive for your OS and architecture (Linux, macOS, Windows) from [GitHub Releases](https://github.com/emresandikci/heybe/releases), unzip it and run it:

```bash
./heybe serve          # Windows: heybe.exe serve
```

On the first start Heybe prints a link to create your first superuser. The dashboard is at `http://127.0.0.1:8090/_/` and the REST API at `http://127.0.0.1:8090/api/`.

`checksums.txt` on each release lists the SHA-256 of every archive. Like PocketBase, the Windows binary cannot restore a backup in place (restoring needs a process restart); restore on Linux, macOS or in Docker.

`heybe serve example.com` serves HTTPS with a Let's Encrypt certificate (HTTP-01). Port 80 and 443 must be reachable from the internet. The certificate is cached in `<dir>/.autocert_cache`.

## Features

- **Core:** HTTP server, storage, base and auth collections, all field types, record CRUD, filter language, API rules, `@heybejs/query`, superusers, password auth, settings.
- **Relations and files:** expand, back-relations, indexes, view collections, batch API, file uploads, thumbnails, protected files, type generation.
- **Auth:** mail and templates, verification, password reset, email change, OAuth2, OTP, MFA, impersonation.
- **Extending and realtime:** hooks, routes, middleware, cron, migrations, console commands, realtime (SSE).
- **Operations:** rate limiting, logs, backups, S3, SQL API.
- **Distribution:** `heybe import`, single binary.

## Extending

### Hooks and routes

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

## Migrating from PocketBase

Stop PocketBase, then import its data directory into a fresh Heybe one:

```bash
heybe import ./pb_data --dir ./heybe_data [--encryptionEnv PB_KEY]
```

Imported: collections (with their rules, indexes and auth token secrets, so issued tokens stay valid), all records, settings and uploaded files (not when PocketBase uses S3). Not imported: logs, backups, migration history, `pb_hooks` and `pb_migrations`. Port hooks and migrations by hand. `--encryptionEnv` names the environment variable that holds the key when PocketBase settings are encrypted.

Collection ids are rewritten to Heybe's prefix: `pbc_<n>` becomes `hbc_<n>` and `_pb_users_auth_` becomes `_hb_users_auth_`, in collections, relation fields, the auth system tables and the storage directories. Code or migrations that hardcode a PocketBase collection id need the new one. Tokens PocketBase issued still carry the old id and are still accepted.

## Dashboard

The superuser panel is served at `/_/`. It covers collections (with a field, rule and index editor), records, logs, backups and all settings. OAuth2 providers of an auth collection are managed under Settings > Auth providers. The records filter, the logs filter, API rules and the SQL fields (view query, indexes, SQL page) autocomplete fields, operators, modifiers, macros and `@request` params as you type.

Record previews block remote images (the dashboard CSP allows none, like PocketBase).

Email templates are written in MJML and compiled in the browser (`mjml-browser`, loaded on demand). The server stores the HTML with the MJML source embedded as a trailing `<!-- heybe:mjml:<base64> -->` comment.

### Extensions

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

An extension can build its page with the dashboard components from `@heybejs/ui`. Install `react`, `react-dom` and `@heybejs/ui` in the extension, bundle it, and render with your own root:

```tsx
import { createRoot } from "react-dom/client";
import { Button } from "@heybejs/ui";
import "@heybejs/ui/style.css";

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

Use `@heybejs/ui` for styled components (buttons, fields, `FileField`, `Select`, `Checkbox`, `Switch`, `Table`, `Dialog`, `Disclosure`, `Badge`, `CodeArea`, toasts and more) and `@heybejs/ui/primitives` for Popover, Menu, MenuItem, Tooltip, Combobox, Tabs, tabPanelIds, Switch, RadioGroup, Dialog and Placement. `ConfirmProvider` and `ToastProvider` must wrap the extension root to use `useConfirm` and `useToast`. Import `@heybejs/ui/style.css` for compiled styles or `@heybejs/ui/theme.css` with Tailwind v4. Light is the default theme; set `data-theme="dark"` on the `html` element for dark mode.

## Docker

The image is not published yet. Build it from the repository:

```bash
docker build -t heybe .
docker run -d -p 8090:8090 -v heybe_data:/heybe/heybe_data heybe
```

Data lives in `/heybe/heybe_data`. User migrations are read from `/heybe/heybe_migrations`, mount your directory there with `-v ./heybe_migrations:/heybe/heybe_migrations`. Create a superuser in a running container:

```bash
docker exec <container> heybe superuser upsert <email> <password> --dir /heybe/heybe_data
```

Windows hosts can run the Linux image through Docker Desktop (WSL2), there is no Windows container image.

## npm

The packages are not published yet. Once they are, `@heybejs/core` runs on Bun only. Install it globally to get the `heybe` command, or add it to a project to use it as a library:

```bash
bun add -g @heybejs/core
bun add @heybejs/core
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup, building the binary and running the tests.

## License

[MIT](LICENSE). Parts of Heybe are ported from PocketBase, fexpr and mimetype, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Heybe is an independent project and is not affiliated with or endorsed by PocketBase or its author.
