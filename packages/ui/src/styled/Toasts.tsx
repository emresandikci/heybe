import { CircleAlert, CircleCheck } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { glass } from "./glass.js";

interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

interface Toasts {
  success(msg: string): void;
  error(msg: string): void;
}

const ToastContext = createContext<Toasts | null>(null);

function renderToast(t: Toast) {
  const Icon = t.kind === "error" ? CircleAlert : CircleCheck;
  return (
    <div
      key={t.id}
      role={t.kind === "error" ? "alert" : undefined}
      className={`${glass} flex items-center gap-2 rounded-base px-3 py-2 text-sm text-text`}
    >
      <Icon
        size={15}
        strokeWidth={1.75}
        className={t.kind === "error" ? "text-danger-text" : "text-accent-text"}
      />
      {t.message}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: Toast["kind"], message: string) => {
    const id = nextId.current++;
    setToasts((all) => [...all, { id, kind, message }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4000);
  }, []);

  const api = useMemo<Toasts>(
    () => ({
      success: (msg) => push("success", msg),
      error: (msg) => push("error", msg),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed right-4 bottom-4 z-50 flex flex-col gap-2"
      >
        {toasts.map(renderToast)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Toasts {
  const toasts = useContext(ToastContext);
  if (!toasts) throw new Error("ToastProvider is missing");
  return toasts;
}
