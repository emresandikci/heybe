import { SettingsLoadError } from "../../settings";
import { ApiError } from "../errors";
import type { RequestEvent, Router } from "../router";
import { requireSuperuser } from "./collections";

const LOAD_FAILED = "An error occurred while loading the submitted data.";

async function update(e: RequestEvent): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
  try {
    e.app.settings.update(body);
  } catch (err) {
    if (err instanceof SettingsLoadError) throw new ApiError(400, LOAD_FAILED);
    throw err;
  }
  return e.json(200, e.app.settings);
}

export function registerSettingsRoutes(router: Router): void {
  router.add("GET", "/api/settings", (e) => {
    requireSuperuser(e);
    return e.json(200, e.app.settings);
  });
  router.add("PATCH", "/api/settings", (e) => {
    requireSuperuser(e);
    return update(e);
  });
}
