import { sqlType } from "../collections/ddl";
import { type FieldDef, fail, required, unsupportedType } from "./shared";

interface GeoPoint {
  lon: number;
  lat: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Like Go's json.Unmarshal into the struct: keys are applied in order and the first bad value stops decoding.
function toPoint(value: unknown): GeoPoint {
  const point = { lon: 0, lat: 0 };
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return point;
    }
  }
  if (!isObject(raw)) return point;
  for (const [key, v] of Object.entries(raw)) {
    if (key !== "lon" && key !== "lat") continue;
    if (v === null) point[key] = 0;
    else if (typeof v === "number" && Number.isFinite(v)) point[key] = v;
    else break;
  }
  return point;
}

export const geoPoint: FieldDef = {
  sqlType: sqlType("geoPoint"),
  normalize: toPoint,
  validate(value, field) {
    if (!isObject(value)) return unsupportedType();
    const { lon, lat } = value as unknown as GeoPoint;
    if (lon === 0 && lat === 0)
      return field.required === true ? required() : null;
    if (lat < -90 || lat > 90)
      return fail(
        "validation_invalid_latitude",
        "Latitude must be between -90 and 90 degrees.",
      );
    if (lon < -180 || lon > 180)
      return fail(
        "validation_invalid_longitude",
        "Longitude must be between -180 and 180 degrees.",
      );
    return null;
  },
  toDb: (value) => JSON.stringify(toPoint(value)),
  fromDb: toPoint,
};
