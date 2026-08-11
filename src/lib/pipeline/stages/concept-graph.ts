import { and, eq, sql } from "drizzle-orm";
import {
  books,
  conceptEdges,
  concepts,
  type ConfusablePair,
  type NewJob,
} from "@/db/schema";
import { claudeMessages, getClaudeClient } from "@/lib/llm/client";
import { requireToolUse } from "@/lib/llm/require-tool";
import { emitConceptGraph } from "@/lib/llm/tools";
import { loadPrompt } from "@/lib/llm/prompts/load";
import { recordStageUsage } from "@/lib/llm/record-usage";
import { markStageDone, markStageRunning } from "../stage-runs";
import type { StageHandler } from "../types";

type EdgeRow = {
  concept_id: string;
  prerequisites?: string[];
  related?: string[];
  confusable_with?: { concept_id: string; distinction: string }[];
};

function normalizeRef(bookId: string, raw: string, known: Set<string>) {
  const t = raw.trim();
  if (!t) return null;
  const full = t.startsWith(bookId) ? t : `${bookId}:${t.replace(/^.*:/, "")}`;
  if (known.has(full)) return full;
  const slug = t.includes(":") ? t.split(":").pop()! : t;
  const hit = [...known].find((id) => id.endsWith(`:${slug}`) || id === slug);
  return hit ?? null;
}

async function breakPrerequisiteCycles(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
  chapterById: Map<string, number | null>,
): Promise<number> {
  let broken = 0;
  for (let guard = 0; guard < 50; guard++) {
    const result = await wdb.execute(sql`
      WITH RECURSIVE walk(start, node, path, cyclic, prev) AS (
        SELECT src, dst, ARRAY[src, dst], src = dst, src
        FROM concept_edges
        WHERE book_id = ${bookId} AND edge_kind = 'prerequisite'
        UNION ALL
        SELECT w.start, e.dst, w.path || e.dst, e.dst = ANY(w.path), w.node
        FROM walk w
        JOIN concept_edges e
          ON e.src = w.node AND e.book_id = ${bookId} AND e.edge_kind = 'prerequisite'
        WHERE NOT w.cyclic AND array_length(w.path, 1) < 12
      )
      SELECT path FROM walk WHERE cyclic LIMIT 1
    `);

    const rows = result.rows as { path: string[] }[];
    if (!rows.length) break;

    const path = rows[0]!.path;
    let deleted = false;
    for (let i = 0; i < path.length - 1; i++) {
      const src = path[i]!;
      const dst = path[i + 1]!;
      const srcCh = chapterById.get(src) ?? 999;
      const dstCh = chapterById.get(dst) ?? 999;
      if (srcCh > dstCh) {
        await wdb
          .delete(conceptEdges)
          .where(
            and(
              eq(conceptEdges.bookId, bookId),
              eq(conceptEdges.src, src),
              eq(conceptEdges.dst, dst),
              eq(conceptEdges.edgeKind, "prerequisite"),
            ),
          );
        deleted = true;
        broken++;
        break;
      }
    }
    if (!deleted && path.length >= 2) {
      const src = path[path.length - 2]!;
      const dst = path[path.length - 1]!;
      await wdb
        .delete(conceptEdges)
        .where(
          and(
            eq(conceptEdges.bookId, bookId),
            eq(conceptEdges.src, src),
            eq(conceptEdges.dst, dst),
            eq(conceptEdges.edgeKind, "prerequisite"),
          ),
        );
      broken++;
    }
  }
  return broken;
}

export const conceptGraphStage: StageHandler = async (job, wdb) => {
  const bookId = job.bookId;
  await markStageRunning(wdb, bookId, "concept_graph");
  await wdb.delete(conceptEdges).where(eq(conceptEdges.bookId, bookId));

  const nodes = await wdb
    .select()
    .from(concepts)
    .where(eq(concepts.bookId, bookId));

  if (nodes.length < 1) {
    throw new Error(
      `concept_graph: only ${nodes.length} concepts — concepts stage likely failed`,
    );
  }

  const known = new Set(nodes.map((n) => n.conceptId));
  const chapterById = new Map(
    nodes.map((n) => [n.conceptId, n.primaryChapter] as const),
  );

  const listing = nodes
    .map(
      (n) =>
        `${n.conceptId} | ${n.label} | ${n.oneLiner} | ch=${n.primaryChapter ?? "?"} | claims=${n.claimIds.length}`,
    )
    .join("\n");

  const { models } = await getClaudeClient();
  const res = await claudeMessages({
    model: models.concepts,
    max_tokens: 16000,
    system: loadPrompt("concept-graph"),
    tools: [emitConceptGraph],
    tool_choice: { type: "tool", name: "emit_concept_graph" },
    messages: [
      {
        role: "user",
        content: `Book ${bookId} — ${nodes.length} concepts:\n\n${listing}`,
      },
    ],
  });

  const { models: activeModels } = await getClaudeClient();
  await recordStageUsage(
    wdb,
    bookId,
    "concept_graph",
    activeModels.concepts,
    res.usage?.input_tokens ?? 0,
    res.usage?.output_tokens ?? 0,
    1,
  );

  const toolBlock = requireToolUse(res, "concept_graph");
  const input = toolBlock.input as { edges?: EdgeRow[] };
  const edgeRows = input.edges || [];

  const edgeInserts: (typeof conceptEdges.$inferInsert)[] = [];
  const prereqByConcept = new Map<string, string[]>();
  const relatedByConcept = new Map<string, string[]>();
  const confusableByConcept = new Map<string, ConfusablePair[]>();

  for (const row of edgeRows) {
    const cid = normalizeRef(bookId, row.concept_id, known);
    if (!cid) continue;

    const prereqs = (row.prerequisites || [])
      .map((p) => normalizeRef(bookId, p, known))
      .filter((p): p is string => p != null && p !== cid)
      .slice(0, 3);
    const related = (row.related || [])
      .map((p) => normalizeRef(bookId, p, known))
      .filter((p): p is string => p != null && p !== cid)
      .slice(0, 5);
    const confusable = (row.confusable_with || [])
      .map((c) => {
        const id = normalizeRef(bookId, c.concept_id, known);
        if (!id || id === cid) return null;
        return {
          concept_id: id,
          distinction: (c.distinction || "").slice(0, 200),
        };
      })
      .filter((c): c is ConfusablePair => c != null)
      .slice(0, 3);

    prereqByConcept.set(cid, prereqs);
    relatedByConcept.set(cid, related);
    confusableByConcept.set(cid, confusable);

    for (const prereq of prereqs) {
      edgeInserts.push({
        bookId,
        src: prereq,
        dst: cid,
        edgeKind: "prerequisite",
        source: "llm",
        weight: 1,
      });
    }
    for (const dst of related) {
      edgeInserts.push({
        bookId,
        src: cid,
        dst,
        edgeKind: "related",
        source: "llm",
        weight: 1,
      });
    }
    for (const c of confusable) {
      edgeInserts.push({
        bookId,
        src: cid,
        dst: c.concept_id,
        edgeKind: "confusable",
        distinction: c.distinction,
        source: "llm",
        weight: 1,
      });
    }
  }

  const seen = new Set<string>();
  const unique = edgeInserts.filter((e) => {
    const k = `${e.src}|${e.dst}|${e.edgeKind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (let i = 0; i < unique.length; i += 100) {
    await wdb.insert(conceptEdges).values(unique.slice(i, i + 100));
  }

  for (const n of nodes) {
    await wdb
      .update(concepts)
      .set({
        prerequisites: prereqByConcept.get(n.conceptId) ?? [],
        related: relatedByConcept.get(n.conceptId) ?? [],
        confusableWith: confusableByConcept.get(n.conceptId) ?? [],
      })
      .where(eq(concepts.conceptId, n.conceptId));
  }

  const cyclesBroken = await breakPrerequisiteCycles(wdb, bookId, chapterById);

  const edged = await wdb.execute(sql`
    SELECT count(DISTINCT c.concept_id) AS n
    FROM concepts c
    JOIN concept_edges e ON e.book_id = c.book_id
      AND (e.src = c.concept_id OR e.dst = c.concept_id)
    WHERE c.book_id = ${bookId}
  `);
  const edgedN = Number((edged.rows[0] as { n: string | number })?.n ?? 0);
  const pct = (edgedN * 100) / nodes.length;
  if (pct < 80) {
    throw new Error(
      `concept_graph: only ${pct.toFixed(0)}% of concepts have edges (need >80%)`,
    );
  }

  const byKind = await wdb.execute(sql`
    SELECT edge_kind, count(*)::int AS n
    FROM concept_edges WHERE book_id = ${bookId}
    GROUP BY edge_kind
  `);
  const counts: Record<string, number> = {};
  for (const row of byKind.rows as { edge_kind: string; n: number }[]) {
    counts[row.edge_kind] = Number(row.n);
  }

  await markStageDone(wdb, bookId, "concept_graph", {
    edgeCounts: counts,
    coveragePct: Math.round(pct),
    cyclesBroken,
    model: activeModels.concepts,
    conceptCount: nodes.length,
  });

  await wdb
    .update(books)
    .set({ status: "ready", readyAt: new Date(), statusError: null })
    .where(eq(books.bookId, bookId));

  // Terminal stage — no successor
  return null;
};
