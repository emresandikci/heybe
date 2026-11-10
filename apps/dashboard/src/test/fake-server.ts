import type { Fetch } from "@heybe/client";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  form: FormData | null;
  headers: Headers;
}

export type Reply =
  ((req: FakeRequest) => unknown) | object | string | number | boolean | null;

export interface FakeServer {
  fetch: Fetch;
  requests: FakeRequest[];
  unmatched: FakeRequest[];
  on(method: string, path: string, reply: Reply, status?: number): FakeServer;
  find(method: string, path: string): FakeRequest[];
  has(method: string, path: string): boolean;
  fallback(method: string, path: string, reply: Reply): FakeServer;
}

interface Route {
  method: string;
  path: string;
  reply: Reply;
  status: number;
}

export const createdServers: FakeServer[] = [];

function pathMatches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  return (
    want.length === got.length &&
    want.every((part, i) => part.startsWith(":") || part === got[i])
  );
}

async function parse(request: Request): Promise<FakeRequest> {
  const url = new URL(request.url);
  const type = request.headers.get("content-type") ?? "";
  let body: unknown;
  let form: FormData | null = null;
  if (type.startsWith("multipart/form-data")) form = await request.formData();
  else {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  }
  return {
    method: request.method,
    path: url.pathname,
    query: url.searchParams,
    body,
    form,
    headers: request.headers,
  };
}

export function fakeServer(): FakeServer {
  const routes: Route[] = [];
  const server: FakeServer = {
    requests: [],
    unmatched: [],
    fetch: async (input, init) => {
      const request = new Request(input as string | Request, init);
      const req = await parse(request);
      server.requests.push(req);
      const route = routes.findLast(
        (r) => r.method === req.method && pathMatches(r.path, req.path),
      );
      if (!route) {
        server.unmatched.push(req);
        return Response.json(
          { code: 404, message: "No fake route.", data: {} },
          { status: 404 },
        );
      }
      const result =
        typeof route.reply === "function"
          ? await route.reply(req)
          : route.reply;
      if (result instanceof Response) return result;
      if (result === undefined) return new Response(null, { status: 204 });
      return Response.json(result, { status: route.status });
    },
    on(method, path, reply, status = 200) {
      routes.push({ method: method.toUpperCase(), path, reply, status });
      return server;
    },
    has: (method, path) =>
      routes.some((r) => r.method === method.toUpperCase() && r.path === path),
    fallback(method, path, reply) {
      routes.unshift({
        method: method.toUpperCase(),
        path,
        reply,
        status: 200,
      });
      return server;
    },
    find: (method, path) =>
      server.requests.filter(
        (r) => r.method === method.toUpperCase() && pathMatches(path, r.path),
      ),
  };
  createdServers.push(server);
  return server;
}
