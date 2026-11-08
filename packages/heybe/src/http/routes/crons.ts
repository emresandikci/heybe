import { requireSuperuserAuth } from "../middlewares";
import type { Router } from "../router";

// Port of PB apis/cron.go; its comparator yields own ids alphabetically, then the __pb ones in order.
export function registerCronRoutes(router: Router): void {
  const guard = requireSuperuserAuth();
  router.route(
    "GET",
    "/api/crons",
    (e) => {
      const jobs = e.app.scheduler
        .jobs()
        .map(({ id, expression }) => ({ id, expression }));
      const own = jobs
        .filter((j) => !j.id.startsWith("__pb"))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const system = jobs.filter((j) => j.id.startsWith("__pb"));
      return e.json(200, [...own, ...system]);
    },
    guard,
  );
  router.route(
    "POST",
    "/api/crons/{id}",
    (e) => {
      const job = e.app.scheduler.jobs().find((j) => j.id === e.params.id);
      if (!job) throw e.notFoundError("Missing or invalid cron job.");
      void job.run();
      return e.noContent(204);
    },
    guard,
  );
}
