import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { mergeRefs } from "../hooks/mergeRefs.js";
import { useDismiss } from "../hooks/useDismiss.js";
import { mergeProps } from "../hooks/mergeProps.js";
import { usePosition } from "../hooks/usePosition.js";
import { useTopLayer } from "../hooks/useTopLayer.js";
import { useOverlayState } from "../state/useOverlayState.js";

export type Placement = NonNullable<
  Parameters<typeof usePosition>[2]["placement"]
>;

export function Popover(props: {
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  className?: string;
  label?: string;
}) {
  const state = useOverlayState(props);
  const id = useId();
  const triggerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(state.open);
  const container = useTopLayer(triggerRef, contentRef, state.open);
  const position = usePosition(triggerRef, contentRef, {
    open: state.open,
    placement: props.placement,
  });
  useDismiss(contentRef, {
    open: state.open,
    onDismiss: state.close,
    triggerRef,
  });

  const restoreFocus = () => {
    if (!document.activeElement || document.activeElement === document.body)
      triggerRef.current?.focus();
  };

  useEffect(() => {
    if (state.open) contentRef.current?.focus();
    else if (wasOpen.current) queueMicrotask(restoreFocus);
    wasOpen.current = state.open;
  }, [state.open]);

  const trigger = cloneElement(
    props.trigger,
    mergeProps(props.trigger.props, {
      ref: mergeRefs(
        triggerRef,
        props.trigger.props.ref as Ref<HTMLElement> | undefined,
      ),
      "aria-expanded": state.open,
      "aria-controls": state.open ? id : undefined,
      "aria-haspopup": "dialog",
      onClick: state.toggle,
    }),
  );

  return (
    <>
      {trigger}
      {container &&
        createPortal(
          <div
            ref={contentRef}
            id={id}
            role="dialog"
            popover="manual"
            aria-label={props.label}
            tabIndex={-1}
            className={props.className}
            style={position.style}
            data-open=""
            data-placement={position.placement}
          >
            {props.children}
          </div>,
          container,
        )}
    </>
  );
}
