import type { App } from "../app";

// Class style for a cron job: `app.register(MyJob)`. The id is the class name unless `id` is set.
export abstract class Cron {
  id?: string;
  abstract schedule: string;
  abstract run(app: App): unknown;
}
