import type { MiddlewareLike, RequestEvent } from "../http/router";

// Class style for a custom route: `app.register(MyRoute)`.
export abstract class Route {
  abstract method: string;
  abstract path: string;
  middlewares?: MiddlewareLike[];
  abstract handle(e: RequestEvent): unknown;
}
