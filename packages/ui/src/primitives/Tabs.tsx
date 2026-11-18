import { useId, useRef, type KeyboardEvent } from "react";

export function tabPanelIds(id: string, value: string) {
  return { tab: `${id}-tab-${value}`, panel: `${id}-panel-${value}` };
}

export function Tabs(props: {
  label: string;
  tabs: { value: string; label: string }[];
  value: string;
  onChange(value: string): void;
  id?: string;
  className?: string;
}) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const listRef = useRef<HTMLDivElement>(null);

  const select = (value: string) => {
    props.onChange(value);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(value)}"]`)
      ?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const last = props.tabs.length - 1;
    const index = props.tabs.findIndex((tab) => tab.value === props.value);
    const target =
      event.key === "ArrowRight"
        ? (index + 1) % props.tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + props.tabs.length) % props.tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (target === -1) return;
    event.preventDefault();
    select(props.tabs[target]!.value);
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
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(tab.value)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
