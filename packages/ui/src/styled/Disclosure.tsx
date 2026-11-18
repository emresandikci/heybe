import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function Disclosure({
  title,
  icon,
  badge,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultOpen);
  const open = controlledOpen ?? inner;
  const toggle = () => {
    setInner(!open);
    onOpenChange?.(!open);
  };
  const bodyId = useId();
  return (
    <div className="rounded-base border border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-base px-3 py-2 text-left text-sm font-medium text-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <ChevronRight
          size={15}
          strokeWidth={1.75}
          aria-hidden
          className={`text-muted transition-transform duration-(--hb-duration) motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
        {icon}
        <span>{title}</span>
        {badge != null && <span className="ml-auto">{badge}</span>}
      </button>
      <div id={bodyId} hidden={!open} className="border-t border-line p-3">
        {children}
      </div>
    </div>
  );
}
