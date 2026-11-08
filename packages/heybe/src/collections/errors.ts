export type Path = (string | number)[];
export type Errors = Record<string, unknown>;
export type Rule = readonly [code: string, message: string];
export interface FieldErr {
  code: string;
  message: string;
  params?: object;
}

export const required: Rule = ["validation_required", "Cannot be blank."];
export const invalidFormat: Rule = [
  "validation_match_invalid",
  "Must be in a valid format.",
];
export const mustBeBlank: Rule = ["validation_empty", "Must be blank."];

export function addError(
  errors: Errors,
  path: Path,
  [code, message]: Rule,
  params?: object,
) {
  let node = errors;
  for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Errors;
  node[path.at(-1)!] = params ? { code, message, params } : { code, message };
}

export const err = ([code, message]: Rule, params?: object): FieldErr =>
  params ? { code, message, params } : { code, message };

export const minRule = (min: number): FieldErr =>
  err(
    [
      "validation_min_greater_equal_than_required",
      `Must be no less than ${min}.`,
    ],
    { threshold: min },
  );

export const maxRule = (max: number): FieldErr =>
  err(
    [
      "validation_max_less_equal_than_required",
      `Must be no greater than ${max}.`,
    ],
    { threshold: max },
  );

export const lengthRule = (min: number, max: number): FieldErr =>
  err(
    [
      "validation_length_out_of_range",
      `The length must be between ${min} and ${max}.`,
    ],
    { min, max },
  );

// ozzo Min/Max skip zero values
export const atLeast = (value: number, min: number): FieldErr | null =>
  value !== 0 && value < min ? minRule(min) : null;

export const atMost = (value: number, max: number): FieldErr | null =>
  value !== 0 && value > max ? maxRule(max) : null;

export const firstError = (...checks: (FieldErr | null)[]): FieldErr | null =>
  checks.find((c) => c !== null) ?? null;

const OZZO_CODES = [
  "validation_required",
  "validation_empty",
  "validation_match_invalid",
  "validation_in_invalid",
  "validation_not_in_invalid",
  "validation_min_greater_equal_than_required",
  "validation_max_less_equal_than_required",
  "validation_length_out_of_range",
];

// The message ozzo-validation puts in Error(), before PB capitalizes it and adds a period for the API.
function rawMessage(e: FieldErr): string {
  if (!OZZO_CODES.includes(e.code)) return e.message;
  return e.message[0]!.toLowerCase() + e.message.slice(1).replace(/\.$/, "");
}

const isFieldErr = (v: object): v is FieldErr =>
  "code" in v && "message" in v && typeof v.message === "string";

export function rawErrors(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (isFieldErr(value)) return rawMessage(value);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => [key, rawErrors(item)]),
  );
}
