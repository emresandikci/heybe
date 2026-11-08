export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface Env {
  fetch: Fetch;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

export const defaultEnv: Env = {
  fetch: (input, init) => globalThis.fetch(input, init),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) =>
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};
