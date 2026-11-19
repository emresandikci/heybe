import { useRef, type KeyboardEvent } from "react";

export function RadioGroup(props: {
  label: string;
  options: { value: string; label: string; disabled?: boolean }[];
  value: string;
  onChange(value: string): void;
  orientation?: "vertical" | "horizontal";
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const orientation = props.orientation ?? "vertical";
  const groupRef = useRef<HTMLDivElement>(null);
  const enabled = props.options
    .filter((option) => !option.disabled)
    .map((option) => option.value);
  const tabStop = enabled.includes(props.value) ? props.value : enabled[0];

  const onKeyDown = (event: KeyboardEvent) => {
    const index = enabled.indexOf(props.value);
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    const target = step
      ? enabled[
          index < 0 && step < 0
            ? enabled.length - 1
            : (index + step + enabled.length) % enabled.length
        ]
      : event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled[enabled.length - 1]
          : undefined;
    if (target === undefined) return;
    event.preventDefault();
    props.onChange(target);
    groupRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(target)}"]`)
      ?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={props.label}
      aria-orientation={orientation}
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      className={props.className}
      onKeyDown={onKeyDown}
    >
      {props.options.map((option) => {
        const checked = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-key={option.value}
            aria-checked={checked}
            data-checked={checked ? "" : undefined}
            disabled={option.disabled}
            tabIndex={option.value === tabStop ? 0 : -1}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
