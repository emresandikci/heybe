const ABORT_MESSAGE = "The request was aborted (most likely autocancelled).";

export interface HeybeErrorInit {
  url?: string;
  status?: number;
  response?: unknown;
  isAbort?: boolean;
  cause?: unknown;
}

export class HeybeError extends Error {
  url: string;
  status: number;
  response: Record<string, unknown>;
  isAbort: boolean;
  cause: unknown;

  constructor(init: HeybeErrorInit = {}) {
    const response =
      init.response !== null && typeof init.response === "object"
        ? (init.response as Record<string, unknown>)
        : {};
    const isAbort = !!init.isAbort;
    const message =
      typeof response.message === "string" && response.message
        ? response.message
        : isAbort
          ? ABORT_MESSAGE
          : "Something went wrong.";
    super(message);
    this.name = "HeybeError";
    this.url = init.url ?? "";
    this.status = init.status ?? 0;
    this.response = response;
    this.isAbort = isAbort;
    this.cause = init.cause;
  }
}
