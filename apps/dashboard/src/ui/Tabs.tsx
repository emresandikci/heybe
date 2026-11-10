import { useRef, type KeyboardEvent } from "react";

export interface TabItem {
  value: string;
  label: string;
}

export function Tabs({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (index + step + tabs.length) % tabs.length;
    onChange(tabs[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 border-b border-slate-200 dark:border-slate-700"
    >
      {tabs.map((tab, i) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`px-3 py-2 text-sm ${selected ? "border-b-2 border-[var(--accent)] font-medium" : "text-slate-500"}`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
