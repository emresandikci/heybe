import type { Target } from "./harness";

// SSE client of /api/realtime for both targets.

const TIMEOUT_MS = 3000;

export interface Frame {
  id: string;
  event: string;
  data: string;
}

export interface SSE {
  target: Target;
  status: number;
  headers: Headers;
  clientId: string;
  // the PB_CONNECT frame as received
  raw: string;
  // the next frame, failing after a bounded wait
  next(): Promise<Frame>;
  subscribe(subscriptions: string[], token?: string | null): Promise<Response>;
  close(): void;
}

function parse(raw: string): Frame {
  const frame: Frame = { id: "", event: "", data: "" };
  for (const line of raw.split("\n")) {
    const i = line.indexOf(":");
    const key = line.slice(0, i) as keyof Frame;
    if (i > 0 && key in frame) frame[key] = line.slice(i + 1);
  }
  return frame;
}

export async function connect(
  t: Target,
  headers: Record<string, string> = {},
): Promise<SSE> {
  const abort = new AbortController();
  const connecting = setTimeout(() => abort.abort(), TIMEOUT_MS);
  const res = await fetch(`${t.url}/api/realtime`, {
    headers,
    signal: abort.signal,
  }).finally(() => clearTimeout(connecting));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const read = async (): Promise<string> => {
    for (;;) {
      const end = buffered.indexOf("\n\n");
      if (end >= 0) {
        const raw = buffered.slice(0, end + 2);
        buffered = buffered.slice(end + 2);
        return raw;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error(`${t.name}: the SSE stream ended`);
      buffered += decoder.decode(value, { stream: true });
    }
  };
  const bounded = async (): Promise<string> => {
    let timer: Timer | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          // the stream is unusable afterwards: the pending read would take the next frame
          timer = setTimeout(() => {
            reject(new Error(`${t.name}: no SSE frame`));
            void reader.cancel().catch(() => {});
          }, TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const raw = await bounded();
  const clientId = parse(raw).id;
  return {
    target: t,
    status: res.status,
    headers: res.headers,
    clientId,
    raw,
    next: async () => parse(await bounded()),
    subscribe: (subscriptions, token = null) =>
      fetch(`${t.url}/api/realtime`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(token ? { authorization: token } : {}),
        },
        body: JSON.stringify({ clientId, subscriptions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    close: () => abort.abort(),
  };
}
