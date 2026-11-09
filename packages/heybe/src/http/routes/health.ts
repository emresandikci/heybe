import type { Router } from "../router";

const PROXY_HEADERS = ["CF-Connecting-IP", "Fly-Client-IP", "X-Forwarded-For"];

// PB apis/health.go
export function registerHealthRoutes(router: Router): void {
  router.route("GET", "/api/health", (e) => {
    let data = {};
    if (e.hasSuperuserAuth()) {
      const headers = [
        ...e.app.settings.current().trustedProxy.headers,
        ...PROXY_HEADERS,
      ];
      data = {
        canBackup: e.app.activeBackup === null,
        realIP: e.realIp(),
        possibleProxyHeader:
          headers.find((h) => (e.req.headers.get(h) ?? "") !== "") ?? "",
      };
    }
    return e.json(200, { message: "API is healthy.", code: 200, data });
  });
}
