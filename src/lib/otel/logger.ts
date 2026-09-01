import { logs, SeverityNumber } from "@opentelemetry/api-logs";

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

function emit(
  severityNumber: SeverityNumber,
  severityText: string,
  consoleFn: (...args: unknown[]) => void,
  message: string,
  attrs?: Attrs,
) {
  const scope = (attrs?.scope as string) || "app";
  consoleFn(`[${scope}] ${message}`, attrs ?? "");
  otelLogger.emit({
    severityNumber,
    severityText,
    body: message,
    attributes: flatten(attrs),
  });
}

export const otelLog = {
  debug: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.DEBUG, "DEBUG", console.debug, message, attrs),
  info: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.INFO, "INFO", console.log, message, attrs),
  warn: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.WARN, "WARN", console.warn, message, attrs),
  error: (message: string, attrs?: Attrs) =>
    emit(SeverityNumber.ERROR, "ERROR", console.error, message, attrs),
};
