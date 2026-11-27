<p><img src="docs/assets/logo.svg" width="64" height="64" alt=""></p>

# Heybe

Heybe is an open source backend in a single binary: database, auth, file storage, realtime and an admin dashboard. It implements the [PocketBase](https://pocketbase.io) HTTP API in TypeScript on [Bun](https://bun.sh), so you can extend it, read its source and debug it without leaving the JavaScript ecosystem.

- Compatible with the PocketBase v0.41.1 HTTP API. Existing PocketBase apps can switch by changing the URL.
- Hooks, routes, cron jobs and migrations in plain TypeScript or JavaScript. No build step, no decorators.
- One typed query syntax for the server and the browser, with types generated from your collections.
- A typed client, `@heybejs/client`, for auth, records, files, realtime and queries.
- `heybe import` moves an existing `pb_data` directory over.

Throughput is close to PocketBase and tail latency is lower in our [benchmarks](docs/benchmarks/phase-9.md).

> The npm packages are not published yet. Use the binaries or the Docker image.

## Quick start

Download the archive for your platform from [GitHub Releases](https://github.com/emresandikci/heybe/releases), unzip it and start the server:

```bash
./heybe serve
```

On the first start Heybe prints a link to create the first superuser. Then open:

- Dashboard: http://127.0.0.1:8090/_/
- REST API: http://127.0.0.1:8090/api/

Each release has a `checksums.txt` with the SHA-256 of every archive.

To serve HTTPS with a Let's Encrypt certificate, pass your domain. Ports 80 and 443 must be reachable from the internet:

```bash
./heybe serve example.com
```

## Docker

```bash
docker run -d -p 8090:8090 -v hb_data:/heybe/hb_data ghcr.io/emresandikci/heybe
```

Images are published for `linux/amd64` and `linux/arm64` and tagged `latest`, `x`, `x.y` and `x.y.z`.

| Path                   | Contents                       |
| ---------------------- | ------------------------------ |
| `/heybe/hb_data`       | Database, uploaded files, logs |
| `/heybe/hb_migrations` | Your migrations                |

Create a superuser from the command line:

```bash
docker exec <container> heybe superuser upsert <email> <password> --dir /heybe/hb_data
```

## Extending

Register hooks and routes as classes:

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
```

Or as functions:

```ts
app.onRecordCreate("posts", async (e) => e.next());
app.get("/hello/{name}", (e) => e.json(200, { message: "Hello" }));
```

## Queries

The same query works on the server and in the browser. Conditions with an `undefined` value are skipped, so form inputs can be passed directly:

```ts
const posts = await heybe.records("posts").findMany({
  where: {
    status: form.status,
    comments: { gt: 50 },
    OR: [{ title: { like: form.search } }, { tags: { anyLike: form.tag } }],
  },
  orderBy: { created: "desc" },
  expand: { author: true },
  page: 1,
  perPage: 30,
});
```

## Features

| Area       | Included                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Data       | Base, auth and view collections, all field types, relations and back-relations, indexes, filters, API rules |
| Auth       | Password, OAuth2, OTP, MFA, verification, password reset, email change, impersonation                       |
| Files      | Uploads, thumbnails, protected files, local or S3 storage                                                   |
| Realtime   | Server-sent events, per collection or per record                                                            |
| Extending  | Hooks, routes, middleware, cron, migrations, console commands, type generation                              |
| Operations | Dashboard, logs, backups, rate limiting, batch API, SQL API, Let's Encrypt                                  |

## Migrating from PocketBase

Heybe imports data directories of PocketBase v0.23 or newer. Older ones have a different format: start PocketBase v0.23 or newer on them once to upgrade them first.

Stop PocketBase, then import its data directory into a new Heybe directory:

```bash
heybe import ./pb_data --dir ./hb_data
```

Collections, rules, indexes, records, settings and uploaded files are imported. Auth token secrets are kept, so tokens PocketBase issued stay valid. If your PocketBase settings are encrypted, pass the name of the variable that holds the key with `--encryptionEnv PB_KEY`.

Not imported: logs, backups, migration history, `pb_hooks` and `pb_migrations`. Hooks and migrations have to be ported by hand. Files stored on S3 stay where they are.

Collection ids get Heybe's prefix: `pbc_<n>` becomes `hbc_<n>` and `_pb_users_auth_` becomes `_hb_users_auth_`. Update any code that hardcodes a PocketBase collection id.

## Dashboard

The dashboard at `/_/` manages collections (fields, rules and indexes), records, logs, backups and settings. Filters, API rules and SQL fields autocomplete fields, operators, macros and `@request` params. Email templates are written in MJML.

Extensions add pages to the dashboard. Register a directory in `onServe` and put a `main.js` in it:

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
    el.textContent = "Signed in as " + client.authStore.record.email;
  },
});
```

To match the dashboard's look, build the extension with React and `@heybejs/ui`, and return a cleanup function from `mount`:

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

`@heybejs/ui` has the styled components and `@heybejs/ui/primitives` the unstyled ones. Wrap the root in `ConfirmProvider` and `ToastProvider` to use `useConfirm` and `useToast`. Use `@heybejs/ui/theme.css` instead of `style.css` with Tailwind v4, and set `data-theme="dark"` on `<html>` for the dark theme.

## Platform notes

- The Windows binary cannot restore a backup in place, because a restore needs a process restart. Restore on Linux, macOS or in Docker.
- There is no Windows container image. Windows hosts can run the Linux image with Docker Desktop (WSL2).
- `@heybejs/core` runs on Bun only. `@heybejs/client` and `@heybejs/query` also run in Node and browsers.

## Contributing

Development setup, tests and building the binary are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Parts of Heybe are ported from PocketBase, fexpr and mimetype; their licenses are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Heybe is an independent project and is not affiliated with or endorsed by PocketBase or its author.
