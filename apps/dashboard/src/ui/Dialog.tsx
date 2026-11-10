import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({
  open,
  onClose,
  title,
  variant = "center",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: "center" | "side";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      if (!dialog.contains(document.activeElement))
        dialog
          .querySelector<HTMLElement>("input, select, textarea, button")
          ?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(
    () => () => {
      (opener.current as HTMLElement | null)?.focus?.();
    },
    [],
  );

  const position =
    variant === "side"
      ? "ml-auto h-dvh max-h-dvh w-full max-w-xl"
      : "m-auto max-w-lg w-full rounded-lg";

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      onClose={(e) => {
        if (e.target !== e.currentTarget) return;
        (opener.current as HTMLElement | null)?.focus?.();
        if (open) onClose();
      }}
      className={`${position} bg-white p-0 text-slate-900 dark:bg-slate-900 dark:text-slate-100`}
    >
      {open && (
        <div className="flex max-h-dvh flex-col">
          <h2
            id={titleId}
            className="border-b border-slate-200 p-4 text-lg font-semibold dark:border-slate-700"
          >
            {title}
          </h2>
          <div className="flex-1 overflow-auto p-4">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-slate-200 p-4 dark:border-slate-700">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
