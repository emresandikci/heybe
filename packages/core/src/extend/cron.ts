import type { App } from "../app";

// Class style for a cron job: `app.register(MyJob)`. The id is `id`, else the class name, else
// cron_<n> like `app.cron(schedule, fn)`.
export abstract class Cron {
  id?: string;
  abstract schedule: string;
  abstract run(app: App): unknown;
}
