import { useControlledState } from "../state/useControlledState.js";

export function Switch(props: {
  label: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?(checked: boolean): void;
  disabled?: boolean;
  className?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [checked, setChecked] = useControlledState(
    props.checked,
    props.defaultChecked ?? false,
    props.onChange,
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={props.label}
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      disabled={props.disabled}
      className={props.className}
      data-checked={checked ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      onClick={() => setChecked(!checked)}
    >
      <span data-thumb="" />
    </button>
  );
}
