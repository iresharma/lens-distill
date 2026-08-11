import {
  getCachedTransportDecision,
  probeDirectAnthropic,
  resolveAnthropicTransport,
} from "@/lib/llm/client";
import { classifyApiLimitError } from "@/lib/llm/api-errors";

export type OpenRouterUsage = {
  configured: boolean;
  ok: boolean;
  error?: string;
  label?: string;
  usageAllTime?: number;
  usageDaily?: number;
  usageWeekly?: number;
  usageMonthly?: number;
  limitUsd?: number | null;
  limitRemainingUsd?: number | null;
  isFreeTier?: boolean;
  /** true when no key-level USD cap is set */
  unlimited?: boolean;
};

export type AnthropicUsage = {
  configured: boolean;
  /** Direct Anthropic Console is accepting calls */
  ok: boolean;
  error?: string;
  /** Active Claude path after auto-resolve */
  transport: "direct" | "openrouter";
  /** Why that transport was chosen */
  transportReason?: string;
  /** usage_cap | rate_limit | overloaded when direct is blocked */
  limitKind?: string;
  regainAt?: string;
};

export type UsageSnapshot = {
  fetchedAt: string;
  anthropic: AnthropicUsage;
  openrouter: OpenRouterUsage;
};

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export async function fetchOpenRouterUsage(): Promise<OpenRouterUsage> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return { configured: false, ok: false, error: "OPENROUTER_API_KEY not set" };
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    const json = (await res.json()) as {
      data?: Record<string, unknown>;
      error?: { message?: string };
    };
    if (!res.ok) {
      return {
        configured: true,
        ok: false,
        error: json.error?.message || `OpenRouter error ${res.status}`,
      };
    }
    const d = json.data ?? {};
    const limitUsd = d.limit == null ? null : num(d.limit);
    const limitRemainingUsd =
      d.limit_remaining == null ? null : num(d.limit_remaining);
    return {
      configured: true,
      ok: true,
      label: typeof d.label === "string" ? d.label : undefined,
      usageAllTime: num(d.usage),
      usageDaily: num(d.usage_daily),
      usageWeekly: num(d.usage_weekly),
      usageMonthly: num(d.usage_monthly),
      limitUsd,
      limitRemainingUsd,
      isFreeTier: Boolean(d.is_free_tier),
      unlimited: limitUsd == null,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      error: e instanceof Error ? e.message : "OpenRouter request failed",
    };
  }
}

/**
 * Probe direct Anthropic, then resolve active transport (auto → OpenRouter
 * on usage cap). UI shows both: Console health + which path distill will use.
 */
export async function fetchAnthropicUsage(): Promise<AnthropicUsage> {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  const [probe, decision] = await Promise.all([
    probeDirectAnthropic(),
    resolveAnthropicTransport({ forceRefresh: true }),
  ]);

  const classified = probe.error
    ? classifyApiLimitError(new Error(probe.error))
    : null;

  return {
    configured,
    ok: probe.ok,
    error: probe.error,
    transport: decision.transport,
    transportReason: decision.reason,
    limitKind: probe.limitKind ?? classified?.kind,
    regainAt: probe.regainAt ?? decision.regainAt,
  };
}

export async function fetchUsageSnapshot(): Promise<UsageSnapshot> {
  const [anthropic, openrouter] = await Promise.all([
    fetchAnthropicUsage(),
    fetchOpenRouterUsage(),
  ]);
  // Keep cache warm for the next pipeline job in this process.
  void getCachedTransportDecision();
  return {
    fetchedAt: new Date().toISOString(),
    anthropic,
    openrouter,
  };
}
