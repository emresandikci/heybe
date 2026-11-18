import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.js";
import { Tooltip } from "./Tooltip.js";

type State = "idle" | "copied" | "failed";

const message = { idle: "Copy", copied: "Copied", failed: "Could not copy" };
const icons = { idle: Copy, copied: Check, failed: TriangleAlert };

export function CopyButton({
  text,
  label = "Copy",
  showLabel = false,
}: {
  text: string;
  label?: string;
  showLabel?: boolean;
}) {
  const [state, setState] = useState<State>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    let next: State = "copied";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = "failed";
    }
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  const Icon = icons[state];
  return (
    <>
      <Tooltip content={message[state]}>
        <Button
          variant={showLabel ? undefined : "ghost"}
          size={showLabel ? undefined : "sm"}
          aria-label={showLabel ? undefined : label}
          onClick={copy}
          icon={
            <Icon
              size={15}
              strokeWidth={1.75}
              className={state === "failed" ? "text-danger-text" : undefined}
            />
          }
        >
          {showLabel && label}
        </Button>
      </Tooltip>
      <span role="status" className="sr-only">
        {state === "idle" ? "" : message[state]}
      </span>
    </>
  );
}
