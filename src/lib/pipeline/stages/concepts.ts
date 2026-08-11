import { and, eq, isNull, sql } from "drizzle-orm";
import { claims, concepts, type NewJob } from "@/db/schema";
import { pickConceptDescription } from "@/lib/concept-description";
import { markStageDone, markStageRunning } from "../stage-runs";
import type { StageHandler } from "../types";

const MIN_CLAIMS_BOOK = 8;
/** Short PDFs (workshops, essays) rarely clear 8 — scale down honestly. */
const MIN_CLAIMS_SHORT = 3;
const SHORT_CORPUS = 150;
const MIN_NODES_BOOK = 5;
const MIN_NODES_SHORT = 1;

function thresholdsFor(liveClaims: number) {
  if (liveClaims < SHORT_CORPUS) {
    return { minClaims: MIN_CLAIMS_SHORT, minNodes: MIN_NODES_SHORT };
  }
  return { minClaims: MIN_CLAIMS_BOOK, minNodes: MIN_NODES_BOOK };
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

function titleCase(raw: string) {
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function modeValue<T extends string>(vals: T[]): T | null {
  if (!vals.length) return null;
  const counts = new Map<T, number>();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  let best = vals[0]!;
  let bestC = 0;
  for (const [k, c] of counts) {
    if (c > bestC) {
      best = k;
      bestC = c;
    }
  }
  return best;
}

async function backfillPrimaryChapters(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
) {
  await wdb.execute(sql`
    UPDATE concepts AS c
    SET primary_chapter = sub.ch
    FROM (
      SELECT co.concept_id, p.chapter_index AS ch,
             ROW_NUMBER() OVER (PARTITION BY co.concept_id ORDER BY count(*) DESC) AS rk
      FROM concepts co
      CROSS JOIN LATERAL unnest(co.claim_ids) cid
      JOIN claims cl ON cl.claim_id = cid AND cl.superseded IS NULL
      CROSS JOIN LATERAL unnest(cl.support_paras) pi
      JOIN paragraphs p ON p.book_id = co.book_id AND p.para_index = pi
      WHERE co.book_id = ${bookId} AND p.chapter_index IS NOT NULL
      GROUP BY co.concept_id, p.chapter_index
    ) sub
    WHERE c.concept_id = sub.concept_id AND sub.rk = 1
  `);
}

async function backfillDefinitionOneLiners(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
) {
  await wdb.execute(sql`
    UPDATE concepts AS c
    SET one_liner = LEFT(sub.statement, 280)
    FROM (
      SELECT DISTINCT ON (co.concept_id)
        co.concept_id,
        cl.statement
      FROM concepts co
      CROSS JOIN LATERAL unnest(co.claim_ids) AS cid
      JOIN claims cl
        ON cl.claim_id = cid
       AND cl.superseded IS NULL
      WHERE co.book_id = ${bookId}
        AND cl.claim_type = 'definition'
        AND position(lower(co.label) in lower(cl.statement)) > 0
      ORDER BY
        co.concept_id,
        LENGTH(cl.statement) ASC
    ) AS sub
    WHERE c.concept_id = sub.concept_id
  `);
}

export const conceptsStage: StageHandler = async (job, wdb) => {
  const bookId = job.bookId;
  await markStageRunning(wdb, bookId, "concepts");
  await wdb.delete(concepts).where(eq(concepts.bookId, bookId));

  const rows = await wdb
    .select({
      claimId: claims.claimId,
      statement: claims.statement,
      claimType: claims.claimType,
      favors: claims.favors,
      concepts: claims.concepts,
      canonicalConcepts: claims.canonicalConcepts,
    })
    .from(claims)
    .where(and(eq(claims.bookId, bookId), isNull(claims.superseded)));

  type Agg = {
    label: string;
    claimIds: string[];
    favors: string[];
    linked: { statement: string; claimType: string }[];
  };
  const groups = new Map<string, Agg>();

  for (const row of rows) {
    const tags =
      row.canonicalConcepts?.length
        ? row.canonicalConcepts
        : row.concepts?.length
          ? row.concepts
          : [];
    for (const raw of tags) {
      const id = slug(raw);
      if (!id) continue;
      const g = groups.get(id) ?? {
        label: titleCase(raw),
        claimIds: [],
        favors: [],
        linked: [],
      };
      if (!g.claimIds.includes(row.claimId)) {
        g.claimIds.push(row.claimId);
        g.linked.push({
          statement: row.statement,
          claimType: row.claimType,
        });
      }
      if (row.favors) g.favors.push(row.favors);
      groups.set(id, g);
    }
  }

  const { minClaims, minNodes } = thresholdsFor(rows.length);

  const tagsAbove = [...groups.values()].filter(
    (g) => g.claimIds.length >= minClaims,
  ).length;

  const values = [...groups.entries()]
    .filter(([, g]) => g.claimIds.length >= minClaims)
    .map(([id, g]) => {
      const favors =
        (modeValue(g.favors) as typeof concepts.$inferInsert.favors) ??
        "not_applicable";
      const oneLiner = pickConceptDescription(g.linked, g.label) ?? g.label;
      return {
        conceptId: `${bookId}:${id}`,
        bookId,
        label: g.label.slice(0, 120),
        oneLiner: oneLiner.slice(0, 280),
        favors,
        primaryChapter: null as number | null,
        claimIds: g.claimIds,
        prerequisites: [] as string[],
        related: [] as string[],
        confusableWith: [] as { concept_id: string; distinction: string }[],
      };
    })
    .sort((a, b) => b.claimIds.length - a.claimIds.length);

  if (values.length < minNodes) {
    throw new Error(
      `concepts: only ${values.length} nodes with ≥${minClaims} claims (${rows.length} live) — canonicalize/extract likely broken`,
    );
  }

  for (let i = 0; i < values.length; i += 50) {
    await wdb.insert(concepts).values(values.slice(i, i + 50));
  }

  await backfillPrimaryChapters(wdb, bookId);
  await backfillDefinitionOneLiners(wdb, bookId);

  await markStageDone(wdb, bookId, "concepts", {
    distinctTags: groups.size,
    tagsAboveThreshold: tagsAbove,
    conceptNodes: values.length,
    minClaims,
    minNodes,
    liveClaims: rows.length,
  });

  return {
    bookId,
    stage: "concept_graph",
    payload: {},
  } satisfies NewJob;
};
