import type { Env } from "./env.js";

interface Recorded {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export function fakeEnv(): Env & {
  requests: Recorded[];
  respond(handler: (req: Request) => Response | Promise<Response>): void;
  advance(ms: number): Promise<void>;
} {
  const requests: Recorded[] = [];
  let handler: (req: Request) => Response | Promise<Response> = () =>
    Response.json({});
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  return {
    requests,
    respond(h) {
      handler = h;
    },
    fetch(input, init) {
      const req = new Request(input, init);
      requests.push({
        method: req.method,
        url: req.url,
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      const signal = init?.signal;
      const aborted = () => new DOMException("Aborted", "AbortError");
      if (signal?.aborted) return Promise.reject(aborted());
      return new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(aborted()), {
          once: true,
        });
        Promise.resolve()
          .then(() => handler(req))
          .then(resolve, reject);
      });
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { id, at: time + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    now: () => time,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        await flush();
        const due = [...timers.values()]
          .filter((t) => t.at <= end)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        time = due.at;
        due.fn();
      }
      time = end;
      await flush();
    },
  };
}

export function jwt(payload: unknown): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

export function sseStream(): {
  response: Response;
  push(text: string): void;
  end(): void;
  fail(): void;
  readonly cancelled: boolean;
} {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new Error("stream failed")),
    get cancelled() {
      return cancelled;
    },
  };
}
