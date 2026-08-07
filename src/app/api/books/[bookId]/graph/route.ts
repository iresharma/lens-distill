import { loadConceptGraph } from "@/lib/load-concept-graph";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await ctx.params;
  const graph = await loadConceptGraph(bookId);
  return Response.json(graph);
}
