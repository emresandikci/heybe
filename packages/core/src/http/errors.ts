import { STATUS_CODES } from "node:http";
import { FilterError } from "../filter/parse";
import { FieldError, NotFoundError, ValidationError } from "../util";
import type { RequestEvent } from "./router";

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "Something went wrong while processing your request.",
  401: "Missing or invalid authentication.",
  403: "You are not allowed to perform this request.",
  404: "The requested resource wasn't found.",
  429: "Too Many Requests.",
  500: "Something went wrong while processing your request.",
};

// Go http.StatusText where it differs from Node's STATUS_CODES.
const GO_STATUS_TEXT: Record<number, string> = {
  413: "Request Entity Too Large",
  414: "Request URI Too Long",
  416: "Requested Range Not Satisfiable",
  418: "I'm a teapot",
};

export const statusText = (status: number): string =>
  GO_STATUS_TEXT[status] ?? STATUS_CODES[status] ?? "";

function sentenize(text: string): string {
  const s = text.trim();
  if (s === "") return "";
  const out = s[0].toUpperCase() + s.slice(1);
  return /[.?!]$/.test(out) ? out : `${out}.`;
}

function sentenizeData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sentenizeData);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      key === "message" && typeof item === "string"
        ? sentenize(item)
        : sentenizeData(item);
  }
  return out;
}

export class ApiError extends Error {
  readonly data: Record<string, unknown>;

  constructor(
    readonly status: number,
    message: string,
    data: Record<string, unknown> = {},
  ) {
    super(sentenize(message || DEFAULT_MESSAGES[status] || statusText(status)));
    this.data = sentenizeData(data) as Record<string, unknown>;
  }
}

export const LOAD_FAILED =
  "An error occurred while loading the submitted data.";

// the request body, PB's 400 load error when it does not parse; a too large body keeps its 413
export async function loadBody(
  e: RequestEvent,
): Promise<Record<string, unknown>> {
  try {
    return await e.body();
  } catch (err) {
    if (err instanceof ApiError && err.status === 413) throw err;
    throw new ApiError(400, LOAD_FAILED);
  }
}

const INVALID_VALUE = {
  code: "validation_invalid_value",
  message: "Invalid value.",
};

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Port of PB router safeErrorsData for error data given to the RequestEvent error helpers: plain
// objects recurse, any other value is reported as an invalid value.
export function safeErrorsData(data: unknown): Record<string, unknown> {
  if (!isPlainObject(data)) return {};
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      isPlainObject(v)
        ? safeErrorsData(v)
        : v instanceof FieldError
          ? { code: v.code, message: v.message }
          : { ...INVALID_VALUE },
    ]),
  );
}

// Expected failures turn into a status silently; anything else is a bug and is logged before conversion.
export function logUnexpected(err: unknown): void {
  if (
    !(err instanceof ApiError) &&
    !(err instanceof ValidationError) &&
    !(err instanceof FilterError) &&
    !(err instanceof NotFoundError)
  )
    console.error(err);
}

// Port of PB router.ToApiError: any other error is a 400 (logged here, since it is likely a bug).
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError)
    return new ApiError(400, err.message, err.data);
  if (err instanceof NotFoundError) return new ApiError(404, err.message);
  console.error(err);
  if ((err as { code?: unknown } | null)?.code === "ENOENT")
    return new ApiError(404, "");
  return new ApiError(400, "");
}

export function errorResponse(err: unknown): Response {
  const e = toApiError(err);
  return Response.json(
    { status: e.status, message: e.message, data: e.data },
    { status: e.status, headers: { "content-type": "application/json" } },
  );
}
