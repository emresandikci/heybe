# Introduction

Heybe is an open source backend in a single binary: database, auth, file storage, realtime and an admin dashboard. It is written in TypeScript and runs on [Bun](https://bun.sh), so you can extend it, read its source and debug it without leaving the JavaScript ecosystem.

- Download one binary, run `./heybe serve`, and you have the API at `/api/` and the dashboard at `/_/`.
- Heybe implements the PocketBase v0.41.1 HTTP API, and `heybe import` moves an existing `pb_data` directory over. See [Migrating from PocketBase](/migrating-from-pocketbase).
- Hooks, routes, cron jobs and migrations are files you drop in a directory. No build step. See [Hooks and routes](/hooks-and-routes).
- The same `where`, `orderBy` and `expand` objects work on the server and in the browser. See [Queries](/queries).
- `@heybejs/client` covers auth, records, files, realtime and batch requests, with types generated from your collections. See [Client](/client).
- Add your own pages to the admin dashboard. See [Dashboard extensions](/dashboard-extensions).

What is included:

| Area       | Included                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Data       | Base, auth and view collections, all field types, relations and back-relations, indexes, filters, API rules |
| Auth       | Password, OAuth2, OTP, MFA, verification, password reset, email change, impersonation                       |
| Files      | Uploads, thumbnails, protected files, local or S3 storage                                                   |
| Realtime   | Server-sent events, per collection or per record                                                            |
| Extending  | Hooks, routes, middleware, cron, migrations, console commands, type generation                              |
| Operations | Dashboard, logs, backups, rate limiting, batch API, SQL API, Let's Encrypt                                  |

Run the server from the [release binaries](/getting-started) or the [Docker image](/docker). The npm packages are `@heybejs/client` and `@heybejs/query` for your app, `@heybejs/core` for editor types and for using the server as a Bun library, and `@heybejs/ui` for [dashboard extensions](/dashboard-extensions).

Start with [Getting started](/getting-started).
