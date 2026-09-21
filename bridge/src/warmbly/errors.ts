// Warmbly API error taxonomy. Retry policy keys off these classes:
// permanent (do not retry), config (pause work, needs operator), conflict
// (resolve idempotently), retryable (backoff and retry).
export type ErrorClass = "permanent" | "config" | "conflict" | "retryable";

export class WarmblyApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = "WarmblyApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function classify(status: number, code: string): ErrorClass {
  if (status === 401 || status === 403) return "config";
  if (status === 429) return "retryable";
  if (status >= 500 || status === 0) return "retryable";
  if (status === 409) return "conflict";
  return "permanent";
}

export function isRetryableClass(cls: ErrorClass): boolean {
  return cls === "retryable";
}
