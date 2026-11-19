import { useId, useRef, type KeyboardEvent } from "react";

export function tabPanelIds(id: string, value: string) {
  return { tab: `${id}-tab-${value}`, panel: `${id}-panel-${value}` };
}

export function Tabs(props: {
  label: string;
  tabs: { value: string; label: string; disabled?: boolean }[];
  value: string;
  onChange(value: string): void;
  id?: string;
  className?: string;
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const listRef = useRef<HTMLDivElement>(null);

  const enabled = props.tabs.filter((tab) => !tab.disabled);
  const tabStop = enabled.some((tab) => tab.value === props.value)
    ? props.value
    : enabled[0]?.value;

  const select = (value: string) => {
    props.onChange(value);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(value)}"]`)
      ?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!enabled.length) return;
    const index = enabled.findIndex((tab) => tab.value === props.value);
    const previous = index <= 0 ? enabled.length - 1 : index - 1;
    const target =
      event.key === "ArrowRight"
        ? enabled[(index + 1) % enabled.length]
        : event.key === "ArrowLeft"
          ? enabled[previous]
          : event.key === "Home"
            ? enabled[0]
            : event.key === "End"
              ? enabled[enabled.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    select(target.value);
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={props.label}
      className={props.className}
      onKeyDown={onKeyDown}
    >
      {props.tabs.map((tab) => {
        const selected = tab.value === props.value;
        const ids = tabPanelIds(id, tab.value);
        return (
          <button
            key={tab.value}
            id={ids.tab}
            role="tab"
            type="button"
            data-key={tab.value}
            aria-selected={selected}
            aria-controls={ids.panel}
            data-selected={selected ? "" : undefined}
            disabled={tab.disabled}
            tabIndex={tab.value === tabStop ? 0 : -1}
            onClick={() => props.onChange(tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
