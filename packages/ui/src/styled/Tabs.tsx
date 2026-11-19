import { Tabs as TabsPrimitive } from "../primitives/Tabs.js";

export interface TabItem {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Tabs(props: {
  label: string;
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <TabsPrimitive
      {...props}
      className="flex gap-1 border-b border-line [&_[role=tab]]:-mb-px [&_[role=tab]]:border-b-2 [&_[role=tab]]:border-transparent [&_[role=tab]]:px-3 [&_[role=tab]]:py-2 [&_[role=tab]]:text-sm [&_[role=tab]]:text-muted [&_[role=tab]]:transition-colors [&_[role=tab]]:duration-[var(--hb-duration)] motion-reduce:[&_[role=tab]]:transition-none [&_[role=tab]:disabled]:cursor-not-allowed [&_[role=tab]:disabled]:opacity-50 [&_[role=tab]:hover:not(:disabled)]:text-text [&_[role=tab]:focus-visible]:outline-2 [&_[role=tab]:focus-visible]:outline-focus [&_[role=tab][data-selected]]:border-accent [&_[role=tab][data-selected]]:font-medium [&_[role=tab][data-selected]]:text-text"
    />
  );
}
