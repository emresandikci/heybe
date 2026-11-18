import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useDismiss } from "../hooks/useDismiss.js";
import { usePosition } from "../hooks/usePosition.js";
import { useTopLayer } from "../hooks/useTopLayer.js";
import { useListState } from "../state/useListState.js";

export type ComboboxOption = { key: string; label: string; disabled?: boolean };

export function Combobox(props: {
  label: string;
  options: ComboboxOption[];
  value: string | null;
  onChange(key: string | null): void;
  inputValue?: string;
  onInputChange?(text: string): void;
  placeholder?: string;
  emptyText?: string;
  className?: string;
  listClassName?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [seenValue, setSeenValue] = useState(props.value);
  if (seenValue !== props.value) {
    setSeenValue(props.value);
    setTyped(null);
  }
  const selectedLabel =
    props.options.find((option) => option.key === props.value)?.label ?? "";
  const text = props.inputValue ?? typed ?? selectedLabel;
  const filterText = text === selectedLabel ? "" : text.toLocaleLowerCase();
  const list = props.onInputChange
    ? props.options
    : props.options.filter((option) =>
        option.label.toLocaleLowerCase().includes(filterText),
      );
  const listState = useListState({
    keys: list.map((option) => option.key),
    disabledKeys: list
      .filter((option) => option.disabled)
      .map((option) => option.key),
  });
  const container = useTopLayer(inputRef, listRef, open);
  const position = usePosition(inputRef, listRef, {
    open,
    placement: "bottom-start",
  });
  useDismiss(listRef, {
    open,
    onDismiss: () => setOpen(false),
    triggerRef: inputRef,
  });

  const setText = (next: string) => {
    props.onInputChange?.(next);
    setTyped(next);
    if (next === "" && props.value !== null) props.onChange(null);
  };
  const select = (key: string) => {
    props.onChange(key);
    const label =
      props.options.find((option) => option.key === key)?.label ?? "";
    props.onInputChange?.(label);
    setTyped(label);
    setOpen(false);
  };

  useEffect(() => {
    if (!open || !listState.activeKey) return;
    document
      .getElementById(`${id}-option-${encodeURIComponent(listState.activeKey)}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [id, listState.activeKey, open]);

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setText(event.currentTarget.value);
    setOpen(true);
    listState.setActiveKey(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        listState.first();
      } else listState.next();
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      listState.previous();
    } else if (event.key === "Enter" && open && listState.activeKey) {
      event.preventDefault();
      select(listState.activeKey);
    } else if (event.key === "Escape" && !open && text) {
      event.preventDefault();
      setText("");
    } else if (event.key === "Tab") setOpen(false);
  };
  const activeOption = listState.activeKey
    ? list.find((option) => option.key === listState.activeKey)
    : undefined;

  return (
    <>
      <label id={`${id}-label`} htmlFor={`${id}-input`}>
        {props.label}
      </label>
      <input
        ref={inputRef}
        id={`${id}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? `${id}-listbox` : undefined}
        aria-activedescendant={
          open && activeOption
            ? `${id}-option-${encodeURIComponent(activeOption.key)}`
            : undefined
        }
        value={text}
        placeholder={props.placeholder}
        className={props.className}
        data-open={open ? "" : undefined}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
      />
      {container &&
        createPortal(
          <div
            ref={listRef}
            popover="manual"
            className={props.listClassName}
            style={{ ...position.style, maxHeight: 240, overflowY: "auto" }}
            data-open=""
            data-placement={position.placement}
          >
            <div
              id={`${id}-listbox`}
              role="listbox"
              aria-labelledby={`${id}-label`}
            >
              {list.map((option) => (
                <div
                  key={option.key}
                  id={`${id}-option-${encodeURIComponent(option.key)}`}
                  role="option"
                  data-key={option.key}
                  data-active={
                    listState.activeKey === option.key ? "" : undefined
                  }
                  aria-selected={props.value === option.key}
                  aria-disabled={option.disabled || undefined}
                  onPointerMove={() =>
                    !option.disabled && listState.setActiveKey(option.key)
                  }
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => !option.disabled && select(option.key)}
                >
                  {option.label}
                </div>
              ))}
            </div>
            {!list.length && (
              <div data-empty="">{props.emptyText ?? "No options"}</div>
            )}
          </div>,
          container,
        )}
    </>
  );
}
