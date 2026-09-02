import { metrics, type Attributes } from "@opentelemetry/api";
import { monitorEventLoopDelay } from "node:perf_hooks";

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

export const llmCallCostUsd = histogram(
  "llm.call.cost.estimated_usd",
  "Estimated USD cost of a single outbound LLM/embedding call (list-price estimate)",
  "1",
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

export const llmCallErrors = counter(
  "llm.call.errors",
  "Outbound LLM/embedding calls that raised without a successful fallback",
  "{error}",
);

export const pipelineBookDuration = histogram(
  "pipeline.book.duration",
  "Wall-clock time from a book being queued to reaching ready",
  "ms",
);

export const pipelineBooksCompleted = counter(
  "pipeline.books.completed",
  "Books that reached a terminal status (ready or failed)",
  "{book}",
);

export const httpServerRequests = counter(
  "http.server.requests",
  "HTTP requests handled by an API route, by route/method/status",
  "{request}",
);

export const httpServerDuration = histogram(
  "http.server.duration",
  "Duration of an API route request, start to response",
  "ms",
);

export const httpServerActiveRequests = upDownCounter(
  "http.server.active_requests",
  "In-flight API route requests",
  "{request}",
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

let processMetricsRegistered = false;

/**
 * Registers process/runtime observable gauges (event-loop lag, uptime)
 * against the real MeterProvider. Same ordering constraint as
 * registerQuotaGauge — must run AFTER startOtel()'s sdk.start().
 *
 * Deliberately excludes CPU/memory — those are pulled from the k8s API
 * (cAdvisor/kubelet summary) instead, so we don't double-report them here.
 */
export function registerProcessMetrics() {
  if (processMetricsRegistered) return;
  processMetricsRegistered = true;

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();

  meter()
    .createObservableGauge("process.uptime", {
      description: "Seconds since the process started",
      unit: "s",
    })
    .addCallback((result) => result.observe(process.uptime()));

  meter()
    .createObservableGauge("nodejs.eventloop.delay.mean", {
      description: "Mean event-loop delay since process start",
      unit: "ms",
    })
    .addCallback((result) => result.observe(eventLoopDelay.mean / 1e6));

  meter()
    .createObservableGauge("nodejs.eventloop.delay.p99", {
      description: "P99 event-loop delay since process start",
      unit: "ms",
    })
    .addCallback((result) => result.observe(eventLoopDelay.percentile(99) / 1e6));
}
