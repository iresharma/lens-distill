import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { classifyApiLimitError } from "@/lib/llm/api-errors";
import { estimateUsd } from "@/lib/llm/pricing";
import { withSpan } from "@/lib/otel/tracer";
import { otelLog } from "@/lib/otel/logger";
import {
  llmFallbackCount,
  llmCallDuration,
  llmCallErrors,
  llmCallCostUsd,
  genAiTokenUsage,
} from "@/lib/otel/meter";
import {
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
} from "@opentelemetry/semantic-conventions/incubating";

function recordLlmMetrics(
  durationMs: number,
  system: string,
  model: string,
  inputTokens?: number,
  outputTokens?: number,
) {
  llmCallDuration.record(durationMs, { "gen_ai.system": system, "gen_ai.request.model": model });
  if (inputTokens != null) {
    genAiTokenUsage.record(inputTokens, {
      "gen_ai.system": system,
      "gen_ai.request.model": model,
      [ATTR_GEN_AI_TOKEN_TYPE]: "input",
    });
  }
  if (outputTokens != null) {
    genAiTokenUsage.record(outputTokens, {
      "gen_ai.system": system,
      "gen_ai.request.model": model,
      [ATTR_GEN_AI_TOKEN_TYPE]: "output",
    });
  }
  if (inputTokens != null || outputTokens != null) {
    const costUsd = estimateUsd(model, inputTokens ?? 0, outputTokens ?? 0);
    llmCallCostUsd.record(costUsd, {
      "gen_ai.system": system,
      "gen_ai.request.model": model,
    });
  }
}

/** Direct Anthropic Console IDs. */
const DIRECT_MODELS = {
  extract: process.env.DISTILL_EXTRACT_MODEL || "claude-haiku-4-5-20251001",
  merge: process.env.DISTILL_MERGE_MODEL || "claude-sonnet-5",
  concepts: process.env.DISTILL_CONCEPTS_MODEL || "claude-opus-5",
  embed: process.env.DISTILL_EMBED_MODEL || "openai/text-embedding-3-small",
} as const;

/** OpenRouter Anthropic model IDs. */
const OPENROUTER_MODELS = {
  extract:
    process.env.DISTILL_EXTRACT_MODEL_OR || "anthropic/claude-haiku-4.5",
  merge: process.env.DISTILL_MERGE_MODEL_OR || "anthropic/claude-sonnet-5",
  concepts:
    process.env.DISTILL_CONCEPTS_MODEL_OR || "anthropic/claude-opus-5",
  embed: process.env.DISTILL_EMBED_MODEL || "openai/text-embedding-3-small",
} as const;

export type DistillModels = {
  extract: string;
  merge: string;
  concepts: string;
  embed: string;
};

export type AnthropicTransport = "direct" | "openrouter";

export type TransportDecision = {
  transport: AnthropicTransport;
  /** Why this path was chosen */
  reason: string;
  /** Direct Anthropic probe result (always attempted unless forced) */
  directOk: boolean;
  directError?: string;
  regainAt?: string;
  decidedAt: number;
};

const CACHE_TTL_MS = 5 * 60_000;

let _decision: TransportDecision | null = null;
let _inflight: Promise<TransportDecision> | null = null;
let _directClient: Anthropic | null = null;
let _orAnthropicClient: Anthropic | null = null;
let _openrouter: OpenAI | null = null;

function envForce(): AnthropicTransport | "auto" {
  const raw = (process.env.DISTILL_ANTHROPIC_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (raw === "direct" || raw === "openrouter") return raw;
  return "auto";
}

function modelsFor(transport: AnthropicTransport): DistillModels {
  return transport === "openrouter" ? OPENROUTER_MODELS : DIRECT_MODELS;
}

function clientFor(transport: AnthropicTransport): Anthropic {
  if (transport === "openrouter") {
    if (!_orAnthropicClient) {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY is not set");
      // Anthropic SDK appends /v1/messages → https://openrouter.ai/api/v1/messages
      _orAnthropicClient = new Anthropic({
        apiKey: key,
        baseURL: "https://openrouter.ai/api",
        defaultHeaders: {
          "HTTP-Referer":
            process.env.OPENROUTER_SITE_URL || "https://lens.iresharma.com",
          "X-Title": process.env.OPENROUTER_APP_NAME || "Lens Distill",
        },
      });
    }
    return _orAnthropicClient;
  }

  if (!_directClient) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    _directClient = new Anthropic({ apiKey: key });
  }
  return _directClient;
}

/** Cheap direct Anthropic probe — usage caps return 400 with a regain date. */
export async function probeDirectAnthropic(): Promise<{
  ok: boolean;
  error?: string;
  regainAt?: string;
  limitKind?: string;
}> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return { ok: false, error: "ANTHROPIC_API_KEY not set" };
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: DIRECT_MODELS.extract,
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
      cache: "no-store",
    });

    if (res.ok) return { ok: true };

    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const msg = json.error?.message || `Anthropic ${res.status}`;
    const classified = classifyApiLimitError(new Error(msg));
    return {
      ok: false,
      error: msg,
      regainAt: classified?.regainAt,
      limitKind: classified?.kind,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Anthropic probe failed",
    };
  }
}

function decideFromProbe(
  probe: Awaited<ReturnType<typeof probeDirectAnthropic>>,
): TransportDecision {
  const decidedAt = Date.now();

  if (probe.ok) {
    return {
      transport: "direct",
      reason: "Anthropic Console available",
      directOk: true,
      decidedAt,
    };
  }

  const hasOr = Boolean(process.env.OPENROUTER_API_KEY);
  const capped = probe.limitKind === "usage_cap" || !process.env.ANTHROPIC_API_KEY;

  if (capped && hasOr) {
    return {
      transport: "openrouter",
      reason: probe.regainAt
        ? `Anthropic usage-capped until ${probe.regainAt} — using OpenRouter`
        : "Anthropic unavailable — using OpenRouter",
      directOk: false,
      directError: probe.error,
      regainAt: probe.regainAt,
      decidedAt,
    };
  }

  // Rate limit / overload: stay on direct so normal backoff applies.
  // No OpenRouter key: stay on direct and let the call fail loudly.
  return {
    transport: "direct",
    reason: hasOr
      ? `Anthropic probe failed (${probe.limitKind || "error"}) — staying direct`
      : "Anthropic probe failed and OPENROUTER_API_KEY is not set",
    directOk: false,
    directError: probe.error,
    regainAt: probe.regainAt,
    decidedAt,
  };
}

/**
 * Resolve which Claude path to use.
 * Default `auto`: probe Anthropic; on usage cap → OpenRouter.
 * Override with DISTILL_ANTHROPIC_TRANSPORT=direct|openrouter.
 */
export async function resolveAnthropicTransport(
  opts?: { forceRefresh?: boolean },
): Promise<TransportDecision> {
  const force = envForce();
  if (force !== "auto") {
    const decidedAt = Date.now();
    _decision = {
      transport: force,
      reason: `Forced via DISTILL_ANTHROPIC_TRANSPORT=${force}`,
      directOk: force === "direct",
      decidedAt,
    };
    return _decision;
  }

  if (
    !opts?.forceRefresh &&
    _decision &&
    Date.now() - _decision.decidedAt < CACHE_TTL_MS
  ) {
    return _decision;
  }

  if (!opts?.forceRefresh && _inflight) return _inflight;

  _inflight = withSpan("llm.transport.probe", {}, async (span) => {
    const probe = await probeDirectAnthropic();
    _decision = decideFromProbe(probe);
    span.setAttribute("llm.transport.decision", _decision.transport);
    span.setAttribute("llm.transport.reason", _decision.reason);
    otelLog.info("transport probe result", {
      scope: "llm",
      transport: _decision.transport,
      directOk: _decision.directOk,
      directError: _decision.directError,
    });
    if (_decision.transport === "openrouter") {
      llmFallbackCount.add(1, { reason: "probe" });
    }
    return _decision;
  });

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Pin transport after a live usage-cap error (skips waiting for cache TTL). */
export function forceOpenRouterFallback(reason: string, regainAt?: string) {
  _decision = {
    transport: "openrouter",
    reason,
    directOk: false,
    directError: reason,
    regainAt,
    decidedAt: Date.now(),
  };
}

export function getCachedTransportDecision(): TransportDecision | null {
  return _decision;
}

/** Sync peek — last resolved transport, else optimistic direct for display. */
export function getAnthropicTransport(): AnthropicTransport {
  return _decision?.transport ?? "direct";
}

/**
 * Claude client + model IDs for the active transport.
 * Call once per stage (or use `claudeMessages` for per-call fallback).
 */
export async function getClaudeClient(): Promise<{
  client: Anthropic;
  models: DistillModels;
  transport: AnthropicTransport;
  decision: TransportDecision;
}> {
  const decision = await resolveAnthropicTransport();
  return {
    client: clientFor(decision.transport),
    models: modelsFor(decision.transport),
    transport: decision.transport,
    decision,
  };
}

/** @deprecated Prefer getClaudeClient() — kept as async alias. */
export async function anthropic(): Promise<Anthropic> {
  const { client } = await getClaudeClient();
  return client;
}

/**
 * Active model IDs for the resolved transport.
 * Prefer awaiting this (or getClaudeClient) over the legacy MODELS export.
 */
export async function getModels(): Promise<DistillModels> {
  const { models } = await getClaudeClient();
  return models;
}

/**
 * Legacy sync MODELS — reflects last cached decision (defaults to direct).
 * Stages that need the live path should use getClaudeClient().
 */
export const MODELS: DistillModels = new Proxy({} as DistillModels, {
  get(_t, prop: string) {
    const models = modelsFor(getAnthropicTransport());
    return models[prop as keyof DistillModels];
  },
});

type MessageCreateParams = Parameters<Anthropic["messages"]["create"]>[0];
type MessageCreateNonStream = Exclude<
  MessageCreateParams,
  { stream: true }
>;

/**
 * messages.create with automatic OpenRouter fallback on Anthropic usage cap.
 */
export async function claudeMessages(params: MessageCreateNonStream) {
  const { client, transport } = await getClaudeClient();
  const start = Date.now();
  return withSpan(
    "llm.claude.messages",
    {
      [ATTR_GEN_AI_SYSTEM]: "anthropic",
      [ATTR_GEN_AI_REQUEST_MODEL]: String(params.model),
      "llm.transport": transport,
    },
    async (span) => {
      try {
        const res = await client.messages.create({ ...params, stream: false });
        span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, res.model);
        recordLlmMetrics(
          Date.now() - start,
          "anthropic",
          res.model,
          res.usage?.input_tokens,
          res.usage?.output_tokens,
        );
        return res;
      } catch (e) {
        const limit = classifyApiLimitError(e);
        if (
          transport === "direct" &&
          limit?.kind === "usage_cap" &&
          process.env.OPENROUTER_API_KEY
        ) {
          otelLog.warn("live usage-cap mid-call, retried via OpenRouter", {
            scope: "llm",
            model: String(params.model),
            regainAt: limit.regainAt,
          });
          llmFallbackCount.add(1, { reason: "mid_call" });
          forceOpenRouterFallback(
            `Live usage-cap mid-call — switched to OpenRouter`,
            limit.regainAt,
          );
          const fallback = await getClaudeClient();
          // Remap native Anthropic model IDs to OpenRouter equivalents if needed.
          const model = remapModelForTransport(
            String(params.model),
            "openrouter",
          );
          span.setAttribute("llm.transport", "openrouter");
          span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, model);
          const res = await fallback.client.messages.create({
            ...params,
            model,
            stream: false,
          });
          recordLlmMetrics(
            Date.now() - start,
            "anthropic",
            model,
            res.usage?.input_tokens,
            res.usage?.output_tokens,
          );
          return res;
        }
        llmCallErrors.add(1, {
          "gen_ai.system": "anthropic",
          "gen_ai.request.model": String(params.model),
          "error.kind": limit?.kind ?? "unknown",
        });
        throw e;
      }
    },
  );
}

function remapModelForTransport(
  model: string,
  transport: AnthropicTransport,
): string {
  if (transport !== "openrouter") return model;
  if (model.startsWith("anthropic/")) return model;
  if (model.includes("haiku")) return OPENROUTER_MODELS.extract;
  if (model.includes("sonnet")) return OPENROUTER_MODELS.merge;
  if (model.includes("opus")) return OPENROUTER_MODELS.concepts;
  return OPENROUTER_MODELS.extract;
}

export function openrouter(): OpenAI {
  if (!_openrouter) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    _openrouter = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL || "https://lens.iresharma.com",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Lens Distill",
      },
    });
  }
  return _openrouter;
}

export type EmbedResult = {
  vectors: number[][];
  /** Embedding APIs bill input/prompt tokens only — no output tokens. */
  inputTokens: number;
};

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], inputTokens: 0 };
  const client = openrouter();
  const models = await getModels();
  const start = Date.now();
  return withSpan(
    "llm.embed",
    {
      [ATTR_GEN_AI_SYSTEM]: "openai",
      "llm.provider": "openrouter",
      [ATTR_GEN_AI_REQUEST_MODEL]: models.embed,
    },
    async () => {
      try {
        const res = await client.embeddings.create({
          model: models.embed,
          input: texts,
        });
        const vectors = res.data
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
        const inputTokens =
          res.usage?.prompt_tokens ??
          res.usage?.total_tokens ??
          texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
        recordLlmMetrics(Date.now() - start, "openai", models.embed, inputTokens);
        return { vectors, inputTokens };
      } catch (e) {
        llmCallErrors.add(1, {
          "gen_ai.system": "openai",
          "gen_ai.request.model": models.embed,
          "error.kind": "unknown",
        });
        throw e;
      }
    },
  );
}
