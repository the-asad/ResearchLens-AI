import type { AiErrorKind, ProviderName } from "./types";

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
    readonly provider: ProviderName,
    readonly status?: number,
    /** Provider-supplied wait hint (Retry-After / "retry in …"), when available. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }

  get retryable() {
    return this.kind === "transient";
  }
}

/** Map an HTTP status to an error kind. Never retry auth or malformed-request failures. */
export function classifyStatus(status: number): AiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  if (status === 400 || status === 404 || status === 409 || status === 413 || status === 422) {
    return "invalid_request";
  }
  return "unknown";
}

/** Parse "2h51m31s" / "18.285s" / "500ms" style durations into milliseconds. */
export function parseDurationMs(text: string | null | undefined): number | undefined {
  if (!text) return undefined;
  const m = /(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:(\d+)ms)?/.exec(text.replace(/\s+/g, ""));
  if (!m || !m[0]) {
    const secs = Number(text);
    return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
  }
  const [, h, min, s, ms] = m;
  const total = (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000 + Number(ms ?? 0);
  return total > 0 ? total : undefined;
}

/**
 * Distinguish quota exhaustion (e.g. "20 requests per day on Free Tier") from short-lived rate
 * limiting: retrying an exhausted daily quota only wastes time.
 */
export function classifyRateLimit(message: string): "quota" | "transient" {
  return /per\s+day|daily|quota exceeded|exceeded your current quota/i.test(message) ? "quota" : "transient";
}

/** Thrown when every configured provider failed. Message is safe to show to users. */
export class AiUnavailableError extends Error {
  constructor(readonly attempts: { provider: ProviderName; model: string; errorKind?: AiErrorKind }[]) {
    super("The AI service is temporarily unavailable. Please try again shortly.");
    this.name = "AiUnavailableError";
  }
}
