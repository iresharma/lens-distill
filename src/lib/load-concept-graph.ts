import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { claims, conceptEdges, concepts } from "@/db/schema";
import {
  claimDefinesConcept,
  pickConceptDescription,
} from "@/lib/concept-description";

export type ConceptGraphNode = {
  id: string;
  label: string;
  oneLiner: string;
  favors: string | null;
  primaryChapter: number | null;
  claimCount: number;
  mastery: number | null;
  sessionId: string | null;
};

export type ConceptGraphEdgeKind =
  | "prerequisite"
  | "related"
  | "confusable"
  | "co_mention";

export type ConceptGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: ConceptGraphEdgeKind;
  label?: string;
  weight: number;
};

export type ConceptGraph = {
  bookId: string;
  nodes: ConceptGraphNode[];
  edges: ConceptGraphEdge[];
};

export async function loadConceptGraph(bookId: string): Promise<ConceptGraph> {
  const rows = await db
    .select({
      conceptId: concepts.conceptId,
      label: concepts.label,
      oneLiner: concepts.oneLiner,
      favors: concepts.favors,
      primaryChapter: concepts.primaryChapter,
      claimIds: concepts.claimIds,
    })
    .from(concepts)
    .where(eq(concepts.bookId, bookId));

  const claimRows = await db
    .select({
      claimId: claims.claimId,
      statement: claims.statement,
      claimType: claims.claimType,
    })
    .from(claims)
    .where(and(eq(claims.bookId, bookId), isNull(claims.superseded)));

  const claimsById = new Map(claimRows.map((c) => [c.claimId, c]));

  const nodes: ConceptGraphNode[] = rows.map((r) => {
    const linked = r.claimIds
      .map((id) => claimsById.get(id))
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => ({ statement: c.statement, claimType: c.claimType }));
    return {
      id: r.conceptId,
      label: r.label,
      oneLiner:
        pickConceptDescription(linked, r.label) ??
        (claimDefinesConcept(r.oneLiner, r.label) ? r.oneLiner : ""),
      favors: r.favors,
      primaryChapter: r.primaryChapter,
      claimCount: r.claimIds.length,
      mastery: null,
      sessionId: null,
    };
  });

  const edgeRows = await db
    .select()
    .from(conceptEdges)
    .where(eq(conceptEdges.bookId, bookId));

  const known = new Set(nodes.map((n) => n.id));
  const edges: ConceptGraphEdge[] = [];
  for (const e of edgeRows) {
    if (!known.has(e.src) || !known.has(e.dst)) continue;
    edges.push({
      id: `${e.edgeKind}:${e.src}->${e.dst}`,
      source: e.src,
      target: e.dst,
      kind: e.edgeKind as ConceptGraphEdgeKind,
      label: e.distinction ?? undefined,
      weight: e.weight,
    });
  }

  return { bookId, nodes, edges };
}
