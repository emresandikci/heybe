import { NotFoundError, ValidationError } from "../util";

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "Something went wrong while processing your request.",
  401: "Missing or invalid authentication.",
  403: "You are not allowed to perform this request.",
  404: "The requested resource wasn't found.",
  429: "Too Many Requests.",
  500: "Something went wrong while processing your request.",
};

const STATUS_TEXT: Record<number, string> = {
  413: "Request Entity Too Large",
};

function sentenize(text: string): string {
  const s = text.trim();
  if (s === "") return "";
  const out = s[0].toUpperCase() + s.slice(1);
  return /[.?!]$/.test(out) ? out : `${out}.`;
}

export class ApiError extends Error {
  readonly data: Record<string, unknown>;

  constructor(
    readonly status: number,
    message: string,
    data: Record<string, unknown> = {},
  ) {
    super(
      sentenize(
        message || DEFAULT_MESSAGES[status] || STATUS_TEXT[status] || "",
      ),
    );
    this.data = data;
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError)
    return new ApiError(400, err.message, err.data);
  if (err instanceof NotFoundError) return new ApiError(404, err.message);
  console.error(err);
  return new ApiError(500, "");
}

export function errorResponse(err: unknown): Response {
  const e = toApiError(err);
  return Response.json(
    { status: e.status, message: e.message, data: e.data },
    { status: e.status, headers: { "content-type": "application/json" } },
  );
}
