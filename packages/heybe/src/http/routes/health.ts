import type { Router } from "../router";

export function registerHealthRoutes(router: Router): void {
  router.add("GET", "/api/health", (e) =>
    e.json(200, { message: "API is healthy.", code: 200, data: {} }),
  );
}
