import { randomSecret } from "../util";

// Port of PB tools/subscriptions.

export interface SubscriptionOptions {
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface Message {
  name: string;
  data: string;
}

// PB inflector.Snakecase
export function snakecase(text: string): string {
  return text
    .split(/[\W_]+/)
    .filter((w) => w !== "")
    .map((w) => w.replace(/(?<=[^A-Z])[A-Z]/g, "_$&"))
    .join("_")
    .toLowerCase();
}

// PB cast.ToString on a decoded JSON value
const castString = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : "";

function parseOptions(topic: string): SubscriptionOptions {
  const options: SubscriptionOptions = { query: {}, headers: {} };
  const q = topic.indexOf("?");
  const raw =
    q < 0
      ? null
      : new URLSearchParams(topic.slice(q + 1).split("#")[0]).get("options");
  if (!raw) return options;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return options;
  }
  const isMap = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isMap(parsed)) return options;
  // like Go, the fields decoded before an invalid one are kept
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "query" && key !== "headers") continue;
    if (value !== null && !isMap(value)) break;
    for (const [k, v] of Object.entries(value ?? {}))
      if (key === "query") options.query[k] = castString(v);
      else options.headers[snakecase(k)] = castString(v);
  }
  return options;
}

export class Client {
  readonly id = randomSecret(40);
  private readonly store = new Map<string, unknown>();
  private readonly subs = new Map<string, SubscriptionOptions>();
  private queue: Message[] = [];
  private wake: (() => void) | null = null;
  private discarded = false;

  subscribe(...topics: string[]): void {
    for (const topic of topics)
      if (topic !== "") this.subs.set(topic, parseOptions(topic));
  }

  // none = all
  unsubscribe(...topics: string[]): void {
    if (topics.length === 0) this.subs.clear();
    for (const topic of topics) this.subs.delete(topic);
  }

  hasSubscription(topic: string): boolean {
    return this.subs.has(topic);
  }

  subscriptions(...prefixes: string[]): Map<string, SubscriptionOptions> {
    if (prefixes.length === 0) return new Map(this.subs);
    const out = new Map<string, SubscriptionOptions>();
    for (const prefix of prefixes)
      for (const [topic, options] of this.subs)
        if (`${topic}?`.startsWith(prefix)) out.set(topic, options);
    return out;
  }

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  unset(key: string): void {
    this.store.delete(key);
  }

  send(m: Message): void {
    if (this.discarded) return;
    this.queue.push(m);
    this.wake?.();
  }

  // the next sent message, null once discarded
  async receive(): Promise<Message | null> {
    while (!this.discarded) {
      const m = this.queue.shift();
      if (m) return m;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
    return null;
  }

  discard(): void {
    if (this.discarded) return;
    this.discarded = true;
    this.queue = [];
    this.wake?.();
  }

  isDiscarded(): boolean {
    return this.discarded;
  }
}

export class Broker {
  private readonly store = new Map<string, Client>();

  clients(): Client[] {
    return [...this.store.values()];
  }

  clientById(id: string): Client | null {
    return this.store.get(id) ?? null;
  }

  register(c: Client): void {
    this.store.set(c.id, c);
  }

  unregister(id: string): void {
    const c = this.store.get(id);
    if (!c) return;
    c.discard();
    this.store.delete(id);
  }
}
