/** Classify provider errors so queue backoff / UI can react correctly. */

export type ApiLimitKind = "usage_cap" | "rate_limit" | "overloaded";

export type ApiLimitInfo = {
  kind: ApiLimitKind;
  /** ISO or human date from the provider message, if present. */
  regainAt?: string;
  /** Short label for UI. */
  label: string;
};

const USAGE_CAP_RE =
  /reached your specified API usage limits|usage.?limit|spend.?limit|credit.?limit/i;
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;
const OVERLOADED_RE = /overloaded|529|capacity/i;
const REGAIN_RE = /regain access on ([^.]+?)(?:\.|"|$)/i;

export function classifyApiLimitError(err: unknown): ApiLimitInfo | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (USAGE_CAP_RE.test(msg)) {
    const m = msg.match(REGAIN_RE);
    return {
      kind: "usage_cap",
      regainAt: m?.[1]?.trim(),
      label: "API usage cap",
    };
  }
  if (RATE_LIMIT_RE.test(msg)) {
    return { kind: "rate_limit", label: "Rate limited" };
  }
  if (OVERLOADED_RE.test(msg)) {
    return { kind: "overloaded", label: "Provider overloaded" };
  }
  return null;
}

/** Monthly spend caps should not burn 3 short retries. */
export function shouldFailImmediately(err: unknown): boolean {
  return classifyApiLimitError(err)?.kind === "usage_cap";
}
