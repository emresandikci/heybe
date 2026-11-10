import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function errorMessage(err: unknown): string {
  const response = (err as { response?: { message?: unknown } } | null)
    ?.response;
  if (typeof response?.message === "string" && response.message)
    return response.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}

export function flattenErrors(
  data: unknown,
  prefix = "",
): Record<string, string> {
  const out: Record<string, string> = {};
  if (data === null || typeof data !== "object") return out;
  const entry = data as Record<string, unknown>;
  if (typeof entry.message === "string" && prefix) {
    out[prefix] = entry.message;
    return out;
  }
  for (const [key, value] of Object.entries(entry)) {
    Object.assign(out, flattenErrors(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

interface Scope {
  errors: Record<string, string>;
  message: string;
  claimed: () => Set<string>;
  subscribe(fn: () => void): () => void;
  claim(path: string): void;
  release(path: string): void;
}

const ScopeContext = createContext<Scope | null>(null);

export function ErrorScope({
  error,
  children,
}: {
  error: unknown;
  children: ReactNode;
}) {
  const listeners = useRef(new Set<() => void>());
  const counts = useRef(new Map<string, number>());
  const scope = useMemo<Scope>(() => {
    const response = (error as { response?: { data?: unknown } } | null)
      ?.response;
    const notify = () => listeners.current.forEach((fn) => fn());
    return {
      errors: error ? flattenErrors(response?.data) : {},
      message: error ? errorMessage(error) : "",
      claimed: () => new Set(counts.current.keys()),
      subscribe(fn) {
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      },
      claim(path) {
        counts.current.set(path, (counts.current.get(path) ?? 0) + 1);
        notify();
      },
      release(path) {
        const next = (counts.current.get(path) ?? 1) - 1;
        if (next <= 0) counts.current.delete(path);
        else counts.current.set(path, next);
        notify();
      },
    };
  }, [error]);
  return (
    <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
  );
}

export function useFieldError(path: string): string | undefined {
  const scope = useContext(ScopeContext);
  useLayoutEffect(() => {
    scope?.claim(path);
    return () => scope?.release(path);
  }, [scope, path]);
  return scope?.errors[path];
}

export function UnclaimedErrors() {
  const scope = useContext(ScopeContext);
  const [, rerender] = useState(0);
  useLayoutEffect(() => {
    const refresh = () => rerender((n) => n + 1);
    refresh();
    return scope?.subscribe(refresh);
  }, [scope]);
  if (!scope || !scope.message) return null;
  const claimed = scope.claimed();
  const rest = Object.entries(scope.errors).filter(
    ([path]) => !claimed.has(path),
  );
  return (
    <div
      role="alert"
      className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
    >
      <p>{scope.message}</p>
      {rest.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {rest.map(([path, message]) => (
            <li key={path}>
              {path}: {message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function useErrorsUnder(
  prefix: string,
  claim = true,
): [string, string][] {
  const scope = useContext(ScopeContext);
  const entries = Object.entries(scope?.errors ?? {}).filter(([path]) =>
    path.startsWith(prefix),
  );
  const paths = claim ? entries.map(([path]) => path).join("\n") : "";
  useLayoutEffect(() => {
    if (!scope || !paths) return;
    const list = paths.split("\n");
    list.forEach((path) => scope.claim(path));
    return () => list.forEach((path) => scope.release(path));
  }, [scope, paths]);
  return entries;
}
