import {
  context,
  trace,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

export const tracer = trace.getTracer("lens-distill");

/** Runs `fn` inside a new active span, recording exceptions and always ending it. */
export async function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      span.end();
    }
  });
}

/**
 * Concurrency-safe variant: creates the span as a child of `parentCtx` and
 * runs `fn` inside `context.with(...)` instead of mutating the implicit
 * "current span". Required when multiple async closures (e.g. a Promise.all
 * worker pool) each want their own child span under one shared parent.
 */
export async function withSpanContext<T>(
  parentCtx: Context,
  name: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, { attributes: attrs }, parentCtx);
  const spanCtx = trace.setSpan(parentCtx, span);
  return context.with(spanCtx, async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (e) {
      span.recordException(e instanceof Error ? e : String(e));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    } finally {
      span.end();
    }
  });
}

export { context, trace };
