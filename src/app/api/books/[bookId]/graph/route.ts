import { loadConceptGraph } from "@/lib/load-concept-graph";
import { withRouteMetrics } from "@/lib/otel/http-metrics";

export const GET = withRouteMetrics(
  "/api/books/[bookId]/graph",
  "GET",
  async (
    _req: Request,
    ctx: { params: Promise<{ bookId: string }> },
  ) => {
    const { bookId } = await ctx.params;
    const graph = await loadConceptGraph(bookId);
    return Response.json(graph);
  },
);
