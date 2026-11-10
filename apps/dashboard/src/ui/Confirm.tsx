import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { TextField } from "./TextField";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
}

type Confirm = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<(ok: boolean) => void>(() => {});

  const confirm = useCallback<Confirm>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current(false);
        resolver.current = resolve;
        setTyped("");
        setOptions(o);
      }),
    [],
  );

  const settle = (ok: boolean) => {
    resolver.current(ok);
    setOptions(null);
  };

  const blocked = !!options?.typeToConfirm && typed !== options.typeToConfirm;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!options}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        footer={
          <>
            <Button onClick={() => settle(false)}>
              {options?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={options?.danger ? "danger" : "primary"}
              disabled={blocked}
              onClick={() => settle(true)}
            >
              {options?.confirmLabel}
            </Button>
          </>
        }
      >
        <p className="text-sm">{options?.message}</p>
        {options?.typeToConfirm && (
          <div className="mt-3">
            <TextField
              label={`Type "${options.typeToConfirm}" to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("ConfirmProvider is missing");
  return confirm;
}
