# Migrating from PocketBase

Heybe implements the PocketBase v0.41.1 HTTP API, so most existing apps work after changing the URL. Heybe also imports PocketBase data directories.

## Import the data

Heybe imports data directories of PocketBase v0.23 or newer. Older ones have a different format: start PocketBase v0.23 or newer on them once to upgrade them first.

Stop PocketBase, then import its data directory into a new Heybe directory:

```bash
heybe import ./pb_data --dir ./hb_data
```

Imported: collections, rules, indexes, records, settings and uploaded files. Auth token secrets are kept, so tokens PocketBase issued stay valid.

If your PocketBase settings are encrypted, pass the name of the environment variable that holds the 32-character key:

```bash
PB_KEY=... heybe import ./pb_data --dir ./hb_data --encryptionEnv PB_KEY
```

Not imported: logs, backups, migration history, `pb_hooks` and `pb_migrations`. Files stored on S3 stay where they are.

## Port hooks and migrations

Hooks and migrations have to be ported by hand. In Heybe they are TypeScript or JavaScript files in `hb_hooks` and `hb_migrations`. See [Hooks and routes](/hooks-and-routes) and [Cron and migrations](/cron-and-migrations).

## Collection ids

Collection ids get Heybe's prefix: `pbc_<n>` becomes `hbc_<n>` and `_pb_users_auth_` becomes `_hb_users_auth_`. Update any code that hardcodes a PocketBase collection id.

## Clients

An app that uses the PocketBase SDK can point at a Heybe server. Realtime sends `PB_CONNECT` before `HB_CONNECT` for this reason. New code can use `@heybejs/client` (see [Client](/client)).
