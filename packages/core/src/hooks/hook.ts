import { randomSecret } from "../util";

const NEXT = Symbol("next");

type Fields<T> = Omit<T, keyof HookEvent>;

export class HookEvent {
  extra: Record<string, unknown> = {};
  [NEXT]: (() => Promise<void>) | undefined;

  static of<T extends HookEvent>(this: new () => T, init: Fields<T>): T {
    return Object.assign(new this(), init);
  }

  next(): Promise<void> {
    return this[NEXT]?.() ?? Promise.resolve();
  }

  tags(): string[] {
    return [];
  }
}

export type HookHandler<T> = (e: T) => unknown;

export interface BindOptions {
  id?: string;
  priority?: number;
  tags?: string[];
}

interface Handler<T> {
  id: string;
  priority: number;
  fn: HookHandler<T>;
}

export class Hook<T extends HookEvent> {
  private handlers: Handler<T>[] = [];

  bind(fn: HookHandler<T>, opts: BindOptions = {}): string {
    const tags = opts.tags ?? [];
    const handler: Handler<T> = {
      id: opts.id ?? "",
      priority: opts.priority ?? 0,
      fn:
        tags.length === 0
          ? fn
          : (e) => (e.tags().some((t) => tags.includes(t)) ? fn(e) : e.next()),
    };
    const index = handler.id
      ? this.handlers.findIndex((h) => h.id === handler.id)
      : -1;
    if (!handler.id) {
      do handler.id = randomSecret(20);
      while (this.handlers.some((h) => h.id === handler.id));
    }
    if (index >= 0) this.handlers[index] = handler;
    else this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);
    return handler.id;
  }

  unbind(...ids: string[]): void {
    for (const id of ids) {
      const index = this.handlers.findLastIndex((h) => h.id === id);
      if (index >= 0) this.handlers.splice(index, 1);
    }
  }

  unbindAll(): void {
    this.handlers = [];
  }

  get length(): number {
    return this.handlers.length;
  }

  trigger(e: T, ...oneOffs: HookHandler<T>[]): Promise<void> {
    const fns = [...this.handlers.map((h) => h.fn), ...oneOffs];
    e[NEXT] = undefined;
    for (let i = fns.length - 1; i >= 0; i--) {
      const fn = fns[i]!;
      const old = e[NEXT];
      e[NEXT] = async () => {
        e[NEXT] = old;
        await fn(e);
      };
    }
    return e.next();
  }
}
