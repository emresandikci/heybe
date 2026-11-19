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
import { useMergeRefs } from "../hooks/useMergeRefs.js";
import { useDismiss } from "../hooks/useDismiss.js";
import { mergeProps } from "../hooks/mergeProps.js";
import { usePosition } from "../hooks/usePosition.js";
import { useTooltipDelay } from "../hooks/useTooltipDelay.js";
import { useTopLayer } from "../hooks/useTopLayer.js";

function hasKeyboardFocus(element: HTMLElement | null) {
  try {
    return element?.matches(":focus-visible") ?? false;
  } catch {
    return element === document.activeElement;
  }
}

export function Tooltip(props: {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}) {
  const delay = useTooltipDelay();
  const id = useId();
  const triggerRef = useRef<HTMLElement>(null);
  const mergedTriggerRef = useMergeRefs(
    triggerRef,
    props.children.props.ref as Ref<HTMLElement> | undefined,
  );
  const tipRef = useRef<HTMLDivElement>(null);
  const container = useTopLayer(triggerRef, tipRef, delay.open);
  const position = usePosition(triggerRef, tipRef, {
    open: delay.open,
    placement: "top",
  });
  useDismiss(tipRef, {
    open: delay.open,
    onDismiss: delay.onLeave,
    triggerRef,
  });

  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const leaveSoon = () => {
    if (hasKeyboardFocus(triggerRef.current)) return;
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(delay.onLeave, 100);
  };
  const stay = () => clearTimeout(leaveTimer.current);

  const trigger = cloneElement(
    props.children,
    mergeProps(props.children.props, {
      ref: mergedTriggerRef,
      "aria-describedby": delay.open ? id : undefined,
      onMouseEnter: () => {
        stay();
        delay.onEnter();
      },
      onMouseLeave: leaveSoon,
      onFocus: delay.onEnter,
      onBlur: () => {
        stay();
        delay.onLeave();
      },
    }),
  );

  return (
    <>
      {trigger}
      {container &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            popover="manual"
            className={props.className}
            style={position.style}
            onMouseEnter={stay}
            onMouseLeave={delay.onLeave}
            data-open=""
            data-placement={position.placement}
          >
            {props.content}
          </div>,
          container,
        )}
    </>
  );
}
