# Cron and migrations

## Cron jobs

Register jobs from a file in `hb_hooks` (see [Hooks and routes](/hooks-and-routes)).

```ts
export default (app) => {
  app.cron("0 3 * * *", async () => {
    // runs every day at 03:00
  });
  app.cron("cleanup", "*/10 * * * *", async (app) => {});
};
```

`app.cron(schedule, fn)` generates an id (`cron_<n>`). `app.cron(id, schedule, fn)` sets it. Class style:

```ts
import { Cron } from "@heybejs/core";

class Cleanup extends Cron {
  schedule = "@hourly";
  run(app) {}
}

export default (app) => app.register(Cleanup);
```

The id is `id` if set, else the class name.

### Schedules

Five fields: minute, hour, day of month, month, day of week. Each field accepts `*`, a number, a range (`1-5`), a list (`1,3,5`) and steps (`*/10`, `1-30/5`). Macros: `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`.

### Built-in jobs

| Id                    | Schedule                  | Does                                                      |
| --------------------- | ------------------------- | --------------------------------------------------------- |
| `__hbDBOptimize__`    | `0 0 * * *`               | Runs `PRAGMA optimize`                                    |
| `__hbLogsCleanup__`   | `0 */6 * * *`             | Deletes logs older than the `logs.maxDays` setting        |
| `__hb<Name>Cleanup__` | `0 * * * *`               | Deletes expired sessions of each type                     |
| `__hbAutoBackup__`    | the backup `cron` setting | Creates an automatic backup (see [Deploying](/deploying)) |

List and run jobs with `heybe.crons.list()` and `heybe.crons.run(id)`, or in the dashboard.

## Migrations

Migrations are files in `hb_migrations`, next to `hb_data`. `--migrationsDir` points elsewhere. They run in file name order. `heybe serve` applies pending ones on start, and applied files are recorded in a `_migrations` table.

```ts
// hb_migrations/1700000000_add_slug.ts
import { migrate } from "@heybejs/core";

export default migrate(
  async (app) => {
    // up
  },
  async (app) => {
    // down
  },
);
```

Class style: `export default class extends Migration { up(app) {} down(app) {} }` with `Migration` from `@heybejs/core`.

### Commands

```bash
heybe migrate create add_slug     # new blank file named <unix time>_add_slug.ts
heybe migrate up                  # run all pending migrations
heybe migrate down 1              # revert the last N applied migrations
heybe migrate collections         # snapshot of the current collections
heybe migrate history-sync        # drop history entries of deleted files
```

### Automigrate

By default, creating, updating or deleting a collection through the dashboard or API writes a migration file (`<unix time>_created_<name>.ts`, `updated_` or `deleted_`) that can recreate or revert the change. It is marked as applied on the instance that made it. Commit these files so other environments apply them. Start with `--automigrate=false` to turn this off.

Migration files can use `newCollection`, `mergeCollection`, `addFieldAt`, `removeFieldById` and `importCollections` from `@heybejs/core`, and `app.collections` to load and save collections.
