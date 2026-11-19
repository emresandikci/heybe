import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useMergeRefs } from "../hooks/useMergeRefs.js";
import { useDismiss } from "../hooks/useDismiss.js";
import { useListKeyboard } from "../hooks/useListKeyboard.js";
import { mergeProps } from "../hooks/mergeProps.js";
import { usePosition } from "../hooks/usePosition.js";
import { useTopLayer } from "../hooks/useTopLayer.js";
import { useListState } from "../state/useListState.js";
import { useOverlayState } from "../state/useOverlayState.js";
import type { Placement } from "./Popover.js";

export type MenuItem =
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
    }
  | { heading: string }
  | { separator: true };

export function Menu(props: {
  trigger: ReactElement<Record<string, unknown>>;
  items: MenuItem[];
  onAction(key: string): void;
  placement?: Placement;
  className?: string;
}) {
  const state = useOverlayState({});
  const id = useId();
  const triggerId =
    (props.trigger.props.id as string | undefined) ?? `${id}-trigger`;
  const triggerRef = useRef<HTMLElement>(null);
  const mergedTriggerRef = useMergeRefs(
    triggerRef,
    props.trigger.props.ref as Ref<HTMLElement> | undefined,
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const actions = props.items.filter((item) => "key" in item);
  const list = useListState({
    keys: actions.map((item) => item.key),
    disabledKeys: actions
      .filter((item) => item.disabled)
      .map((item) => item.key),
  });
  const container = useTopLayer(triggerRef, menuRef, state.open);
  const position = usePosition(triggerRef, menuRef, {
    open: state.open,
    placement: props.placement ?? "bottom-start",
  });
  useDismiss(menuRef, { open: state.open, onDismiss: state.close, triggerRef });

  const activate = (key: string) => {
    state.close();
    props.onAction(key);
  };
  const keyboard = useListKeyboard(list, {
    orientation: "vertical",
    labels: Object.fromEntries(actions.map((item) => [item.key, item.label])),
    onSelect: activate,
  });

  const restoreFocus = () => {
    if (!document.activeElement || document.activeElement === document.body)
      triggerRef.current?.focus();
  };

  useEffect(() => {
    if (state.open && list.activeKey)
      menuRef.current
        ?.querySelector<HTMLElement>(
          `[data-key="${CSS.escape(list.activeKey)}"]`,
        )
        ?.focus();
  }, [state.open, list.activeKey]);

  useEffect(() => {
    if (!state.open && wasOpen.current) queueMicrotask(restoreFocus);
    wasOpen.current = state.open;
  }, [state.open]);

  const checkedKey = actions.find((item) => item.checked)?.key;
  const openAt = (edge: "first" | "last") => {
    if (checkedKey) list.setActiveKey(checkedKey);
    else list[edge]();
    state.setOpen(true);
  };
  const triggerKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAt(event.key === "ArrowDown" ? "first" : "last");
  };
  const menuKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      state.close();
      return;
    }
    keyboard.onKeyDown(event);
  };

  const trigger = cloneElement(
    props.trigger,
    mergeProps(props.trigger.props, {
      ref: mergedTriggerRef,
      id: triggerId,
      "aria-expanded": state.open,
      "aria-controls": state.open ? id : undefined,
      "aria-haspopup": "menu",
      onClick: () => {
        if (!state.open) {
          if (checkedKey) list.setActiveKey(checkedKey);
          else list.first();
        }
        state.toggle();
      },
      onKeyDown: triggerKeyDown,
    }),
  );

  return (
    <>
      {trigger}
      {container &&
        createPortal(
          <div
            ref={menuRef}
            id={id}
            role="menu"
            popover="manual"
            aria-labelledby={triggerId}
            className={props.className}
            style={position.style}
            onKeyDown={menuKeyDown}
            data-open=""
            data-placement={position.placement}
          >
            {props.items.map((item, index) =>
              "separator" in item ? (
                <div key={`separator-${index}`} role="separator" />
              ) : "heading" in item ? (
                <div
                  key={`heading-${index}`}
                  role="presentation"
                  data-heading=""
                >
                  {item.heading}
                </div>
              ) : (
                <div
                  key={item.key}
                  role={
                    item.checked === undefined ? "menuitem" : "menuitemradio"
                  }
                  aria-checked={item.checked}
                  data-key={item.key}
                  tabIndex={list.activeKey === item.key ? 0 : -1}
                  aria-disabled={item.disabled || undefined}
                  data-disabled={item.disabled ? "" : undefined}
                  data-active={list.activeKey === item.key ? "" : undefined}
                  data-danger={item.danger ? "" : undefined}
                  onClick={() => !item.disabled && activate(item.key)}
                  onPointerMove={() =>
                    !item.disabled && list.setActiveKey(item.key)
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.shortcut && <kbd>{item.shortcut}</kbd>}
                </div>
              ),
            )}
          </div>,
          container,
        )}
    </>
  );
}
