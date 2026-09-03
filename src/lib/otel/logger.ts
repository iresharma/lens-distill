import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { trace, isSpanContextValid } from "@opentelemetry/api";

const otelLogger = logs.getLogger("lens-distill");

type Attrs = Record<string, unknown>;

function flatten(attrs?: Attrs): Record<string, string | number | boolean> {
  if (!attrs) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

/**
 * JSON.stringify replacer: Errors serialize to name/message/stack instead of
 * `{}`, BigInts don't throw, and circular refs degrade instead of crashing
 * the logger itself.
 */
function safeReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  level: string,
  consoleFn: (line: string) => void,
  message: string,
  attrs?: Attrs,
) {
  const { scope, ...rest } = attrs ?? {};
  const spanContext = trace.getActiveSpan()?.spanContext();

  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg: message,
    scope: (scope as string) || "app",
    ...rest,
  };
  // Ties every log line back to the OTel trace for the request/pipeline run
  // it was emitted during, so logs for one request can be grepped by ID.
  if (spanContext && isSpanContextValid(spanContext)) {
    record.trace_id = spanContext.traceId;
    record.span_id = spanContext.spanId;
  }

  consoleFn(JSON.stringify(record, safeReplacer()));

  otelLogger.emit({
    severityNumber,
    severityText,
    body: message,
    attributes: flatten(attrs),
  });
}

export const otelLog = {
  debug: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.DEBUG, "DEBUG", "debug", console.debug, message, attrs),
  info: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.INFO, "INFO", "info", console.log, message, attrs),
  warn: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.WARN, "WARN", "warn", console.warn, message, attrs),
  error: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.ERROR, "ERROR", "error", console.error, message, attrs),
};
