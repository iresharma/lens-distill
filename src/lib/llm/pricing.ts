/** Rough list prices for demo billing display — override via env if needed. */

export type ModelKind = "extract" | "merge" | "graph" | "embed";

type Rate = { inputPerMTok: number; outputPerMTok: number };

const RATES: Record<string, Rate> = {
  // Anthropic (USD / million tokens) — approximate public list
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75 },
  // Embeddings: billed on input tokens only
  "openai/text-embedding-3-small": { inputPerMTok: 0.02, outputPerMTok: 0 },
};

function rateFor(model: string): Rate {
  if (RATES[model]) return RATES[model]!;
  if (model.includes("haiku")) return RATES["claude-haiku-4-5-20251001"]!;
  if (model.includes("sonnet")) return RATES["claude-sonnet-5"]!;
  if (model.includes("opus")) return RATES["claude-opus-5"]!;
  if (model.includes("embedding")) return RATES["openai/text-embedding-3-small"]!;
  return { inputPerMTok: 3, outputPerMTok: 15 };
}

export function estimateUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const r = rateFor(model);
  return (
    (inputTokens / 1_000_000) * r.inputPerMTok +
    (outputTokens / 1_000_000) * r.outputPerMTok
  );
}

export type UsageSlice = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimatedUsd: number;
};

export type UsageRollup = {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  estimatedUsd: number;
  byModel: Record<string, UsageSlice>;
  /** true when figures include post-hoc estimates for stages that didn't log usage */
  includesEstimates?: boolean;
};

export function emptyUsage(): UsageRollup {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    estimatedUsd: 0,
    byModel: {},
  };
}

export function addUsage(
  rollup: UsageRollup,
  model: string,
  inputTokens: number,
  outputTokens: number,
  calls = 1,
): UsageRollup {
  const usd = estimateUsd(model, inputTokens, outputTokens);
  const prev = rollup.byModel[model] ?? {
    model,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    estimatedUsd: 0,
  };
  return {
    inputTokens: rollup.inputTokens + inputTokens,
    outputTokens: rollup.outputTokens + outputTokens,
    calls: rollup.calls + calls,
    estimatedUsd: rollup.estimatedUsd + usd,
    byModel: {
      ...rollup.byModel,
      [model]: {
        model,
        inputTokens: prev.inputTokens + inputTokens,
        outputTokens: prev.outputTokens + outputTokens,
        calls: prev.calls + calls,
        estimatedUsd: prev.estimatedUsd + usd,
      },
    },
    includesEstimates: rollup.includesEstimates,
  };
}

export function mergeUsage(a: UsageRollup, b: UsageRollup): UsageRollup {
  let out = { ...a, byModel: { ...a.byModel } };
  for (const slice of Object.values(b.byModel)) {
    out = addUsage(
      out,
      slice.model,
      slice.inputTokens,
      slice.outputTokens,
      slice.calls,
    );
  }
  out.includesEstimates = Boolean(a.includesEstimates || b.includesEstimates);
  return out;
}
