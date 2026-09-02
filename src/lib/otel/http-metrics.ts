import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from "@opentelemetry/semantic-conventions";
import {
  httpServerActiveRequests,
  httpServerDuration,
  httpServerRequests,
} from "./meter";

/**
 * Wraps a Next.js route handler with request-count/duration/in-flight
 * metrics, keyed by the static route template (never the resolved dynamic
 * segments — e.g. "/api/books/[bookId]", not a real bookId) to keep label
 * cardinality bounded.
 */
export function withRouteMetrics<Args extends unknown[]>(
  route: string,
  method: string,
  handler: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    const attrs = {
      [ATTR_HTTP_ROUTE]: route,
      [ATTR_HTTP_REQUEST_METHOD]: method,
    };
    const start = performance.now();
    httpServerActiveRequests.add(1, attrs);
    let statusCode = 500;
    try {
      const res = await handler(...args);
      statusCode = res.status;
      return res;
    } finally {
      httpServerActiveRequests.add(-1, attrs);
      const finalAttrs = {
        ...attrs,
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
      };
      httpServerDuration.record(performance.now() - start, finalAttrs);
      httpServerRequests.add(1, finalAttrs);
    }
  };
}
