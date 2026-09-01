import { metrics, type Attributes } from "@opentelemetry/api";

/**
 * Unlike trace/logs, the metrics API has no proxy-provider fallback: a
 * Counter/Histogram created via metrics.getMeter(...) BEFORE startOtel()
 * registers the real MeterProvider is permanently bound to a no-op meter.
 * Module load order (e.g. scripts/resume-drain.ts's flat static imports)
 * can't guarantee startOtel() has run first, so every instrument here
 * re-resolves metrics.getMeter() on each call instead of caching one at
 * module scope.
 */
function meter() {
  return metrics.getMeter("lens-distill");
}

function counter(name: string, description: string, unit: string) {
  return {
    add(value: number, attrs?: Attributes) {
      meter().createCounter(name, { description, unit }).add(value, attrs);
    },
  };
}

function upDownCounter(name: string, description: string, unit: string) {
  return {
    add(value: number, attrs?: Attributes) {
      meter()
        .createUpDownCounter(name, { description, unit })
        .add(value, attrs);
    },
  };
}

function histogram(name: string, description: string, unit: string) {
  return {
    record(value: number, attrs?: Attributes) {
      meter().createHistogram(name, { description, unit }).record(value, attrs);
    },
  };
}

export const jobsClaimed = counter(
  "pipeline.jobs.claimed",
  "Job rows claimed off the pipeline queue",
  "{job}",
);

export const jobsFailed = counter(
  "pipeline.jobs.failed",
  "Job rows that failed (retry or dead-letter)",
  "{job}",
);

export const jobsDeadlettered = counter(
  "pipeline.jobs.deadlettered",
  "Job rows permanently dead-lettered",
  "{job}",
);

export const stageDuration = histogram(
  "pipeline.stage.duration",
  "Wall-clock duration of a logical pipeline stage, start to finish",
  "ms",
);

export const stageFailed = counter(
  "pipeline.stage.failed",
  "Pipeline stages that ended in a failed state",
  "{stage}",
);

export const queueDepth = upDownCounter(
  "pipeline.queue.depth",
  "Pending/in-flight job rows currently queued, by stage",
  "{job}",
);

export const llmFallbackCount = counter(
  "llm.fallback.count",
  "Times the LLM transport fell back from direct Anthropic to OpenRouter",
  "{event}",
);

export const llmCallDuration = histogram(
  "llm.call.duration",
  "Duration of an outbound LLM/embedding call",
  "ms",
);

export const genAiTokenUsage = histogram(
  "gen_ai.client.token.usage",
  "Number of tokens used per GenAI client call",
  "{token}",
);

export const pipelineTokensInput = counter(
  "pipeline.tokens.input",
  "Cumulative input tokens billed across the pipeline",
  "{token}",
);

export const pipelineTokensOutput = counter(
  "pipeline.tokens.output",
  "Cumulative output tokens billed across the pipeline",
  "{token}",
);

export const pipelineCostEstimatedUsd = counter(
  "pipeline.cost.estimated_usd",
  "Cumulative estimated USD cost across the pipeline (estimate, not billing-accurate)",
  "1",
);

export const quotaExceededCount = counter(
  "pipeline.quota.exceeded.count",
  "Times an upload was rejected for exceeding the weekly book quota",
  "{event}",
);

let quotaGaugeRegistered = false;

/**
 * Registers the pipeline.quota.remaining observable gauge against the real
 * MeterProvider. Must be called AFTER startOtel() has run (sdk.ts calls this
 * right after sdk.start()) — an observable instrument's callback can't be
 * "moved" to a real provider once registered against a no-op one.
 */
export function registerQuotaGauge() {
  if (quotaGaugeRegistered) return;
  quotaGaugeRegistered = true;
  meter()
    .createObservableGauge("pipeline.quota.remaining", {
      description: "Remaining book-upload slots in the current rolling week",
      unit: "{slot}",
    })
    .addCallback(async (result) => {
      const { getSlotsRemaining } = await import("@/lib/quota");
      const slots = await getSlotsRemaining().catch(() => null);
      if (slots) result.observe(slots.remaining);
    });
}
