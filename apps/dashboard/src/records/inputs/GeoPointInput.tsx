import { useId } from "react";
import { NumberField } from "@heybejs/ui";

export type GeoValue = { lon: string; lat: string };

export function GeoPointInput({
  name,
  value,
  error,
  disabled,
  onChange,
}: {
  name: string;
  value: GeoValue;
  error?: string;
  disabled: boolean;
  onChange: (value: GeoValue) => void;
}) {
  const errorId = useId();
  const aria = {
    "aria-invalid": error ? (true as const) : undefined,
    "aria-describedby": error ? errorId : undefined,
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{name}</legend>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Longitude"
          min={-180}
          max={180}
          step="any"
          value={value.lon}
          disabled={disabled}
          {...aria}
          onChange={(e) => onChange({ ...value, lon: e.target.value })}
        />
        <NumberField
          label="Latitude"
          min={-90}
          max={90}
          step="any"
          value={value.lat}
          disabled={disabled}
          {...aria}
          onChange={(e) => onChange({ ...value, lat: e.target.value })}
        />
      </div>
      {error && (
        <p id={errorId} className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </fieldset>
  );
}
