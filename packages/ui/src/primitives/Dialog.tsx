import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FIRST_FOCUS = ["body", "footer"]
  .flatMap((part) =>
    ["input", "select", "textarea", "button"].map(
      (tag) => `[data-part=${part}] ${tag}:not([disabled])`,
    ),
  )
  .join(", ");

export function Dialog(props: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  closeIcon?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();

  const restoreFocus = () => {
    (opener.current as HTMLElement | null)?.focus?.();
    opener.current = null;
  };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) {
        const first = [
          ...dialog.querySelectorAll<HTMLElement>(FIRST_FOCUS),
        ].find((el) => !el.closest("[hidden]"));
        (
          first ?? dialog.querySelector<HTMLElement>("[data-part=close]")
        )?.focus();
      }
    }
    if (!props.open && dialog.open) {
      dialog.close();
      restoreFocus();
    }
  }, [props.open]);

  useEffect(() => restoreFocus, []);

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={props.className}
      onSubmit={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
      onClose={(event) => {
        if (event.target !== event.currentTarget) return;
        restoreFocus();
        if (props.open) props.onClose();
      }}
    >
      {props.open && (
        <div data-part="content">
          <div data-part="header">
            <h2 id={titleId} data-part="title">
              {props.title}
            </h2>
            <button
              type="button"
              data-part="close"
              aria-label="Close"
              onClick={props.onClose}
            >
              {props.closeIcon ?? "\u00d7"}
            </button>
          </div>
          <div data-part="body">{props.children}</div>
          {props.footer && <div data-part="footer">{props.footer}</div>}
        </div>
      )}
    </dialog>,
    document.body,
  );
}
