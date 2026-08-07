import { and, eq, isNull } from "drizzle-orm";
import {
  claims,
  conceptVocab,
  type NewJob,
} from "@/db/schema";
import { embedTexts } from "@/lib/llm/client";
import { markStageDone, markStageRunning } from "../stage-runs";
import type { StageHandler } from "../types";

const EMBED_BATCH = 100;
const CLUSTER_THRESHOLD = 0.93;
const MIN_CLAIMS_FOR_EMBED = 2;

const CONTAINER_RE =
  /_(agreements?|clauses?|provisions?|covenants?|languages?|sections?|terms)$/;

/** Surface form stored as concept_vocab.raw_tag (separators collapsed, no container strip). */
function surfaceNormalize(raw: string): string {
  let t = raw.toLowerCase().trim();
  t = t.replace(/^(the|a|an)\s+/, "");
  t = t.replace(/[-\s/.]+/g, "_");
  t = t.replace(/[^a-z0-9_]/g, "");
  t = t.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return t;
}

function singularizeToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (/(ss|us|is|as)$/.test(token)) return token;
  if (/[^s]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/**
 * Rule 1 — aggressive normal form used for clustering.
 * Identical normal forms ⇒ same concept (no embedding needed).
 */
export function normalizeTag(raw: string): string {
  let t = surfaceNormalize(raw);
  while (CONTAINER_RE.test(t)) {
    t = t.replace(CONTAINER_RE, "");
  }
  t = t
    .split("_")
    .filter(Boolean)
    .map(singularizeToken)
    .join("_");
  return t.replace(/_+/g, "_").replace(/^_|_$/g, "");
}

/**
 * Rule 2 — negation status. Prefixes checked longest-first.
 * Tags whose status differs must never merge.
 */
export function isNegated(tag: string): boolean {
  const letters = tag.toLowerCase().replace(/[^a-z]/g, "");
  return /^(non|anti|dis|de|un|no)/.test(letters);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function pickCanonical(members: string[], tagCounts: Map<string, number>): string {
  let best = members[0]!;
  let bestCount = tagCounts.get(best) || 0;
  for (let i = 1; i < members.length; i++) {
    const tag = members[i]!;
    const c = tagCounts.get(tag) || 0;
    if (c > bestCount || (c === bestCount && tag.length < best.length)) {
      best = tag;
      bestCount = c;
    }
  }
  return best;
}

function assertNoNegationCrossMerge(rawToCanonical: Map<string, string>) {
  const violations: string[] = [];
  for (const [raw, canonical] of rawToCanonical) {
    if (raw === canonical) continue;
    if (isNegated(normalizeTag(raw)) !== isNegated(normalizeTag(canonical))) {
      violations.push(`${raw} → ${canonical}`);
    }
  }
  if (violations.length) {
    throw new Error(
      `canonicalize G3 failed: negation cross-merge(s): ${violations.slice(0, 10).join("; ")}`,
    );
  }
}

/**
 * Pass A: cluster raw claim tags into a canonical vocabulary.
 * String-normalize first; embeddings are a guarded fallback only.
 * Writes concept_vocab + claims.canonical_concepts; does not rewrite claims.concepts.
 */
export const canonicalizeStage: StageHandler = async (job, wdb) => {
  const bookId = job.bookId;
  await markStageRunning(wdb, bookId, "canonicalize");

  await wdb.delete(conceptVocab).where(eq(conceptVocab.bookId, bookId));

  const rows = await wdb
    .select({
      claimId: claims.claimId,
      concepts: claims.concepts,
    })
    .from(claims)
    .where(and(eq(claims.bookId, bookId), isNull(claims.superseded)));

  const tagCounts = new Map<string, number>();
  const claimTags = new Map<string, string[]>();

  for (const row of rows) {
    const tags = (row.concepts || [])
      .map(surfaceNormalize)
      .filter((t) => t.length > 1);
    claimTags.set(row.claimId, tags);
    for (const t of tags) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
  }

  const distinct = [...tagCounts.keys()];
  if (!distinct.length) {
    await markStageDone(wdb, bookId, "canonicalize", {
      rawTagCount: 0,
      canonicalTagCount: 0,
    });
    return { bookId, stage: "concepts", payload: {} } satisfies NewJob;
  }

  // Rule 1: cluster by identical normal form
  const normalToTags = new Map<string, string[]>();
  for (const tag of distinct) {
    const n = normalizeTag(tag);
    if (!n) continue;
    const list = normalToTags.get(n) || [];
    list.push(tag);
    normalToTags.set(n, list);
  }

  // Clusters keyed by a provisional member list (surface tags)
  const clusters: string[][] = [];
  const assigned = new Set<string>();

  for (const members of normalToTags.values()) {
    clusters.push([...members]);
    for (const m of members) assigned.add(m);
  }

  // Rule 3: embed only singleton clusters with enough claims
  const embedCandidates = clusters
    .filter((c) => c.length === 1)
    .map((c) => c[0]!)
    .filter((t) => (tagCounts.get(t) || 0) >= MIN_CLAIMS_FOR_EMBED);

  if (embedCandidates.length > 1) {
    const embeddings: number[][] = [];
    for (let i = 0; i < embedCandidates.length; i += EMBED_BATCH) {
      const batch = embedCandidates.slice(i, i + EMBED_BATCH);
      const { vectors: vecs } = await embedTexts(
        batch.map((t) => t.replace(/_/g, " ")),
      );
      embeddings.push(...vecs);
    }

    const used = new Set<number>();
    const embedClusters: string[][] = [];
    for (let i = 0; i < embedCandidates.length; i++) {
      if (used.has(i)) continue;
      const seedTag = embedCandidates[i]!;
      const cluster = [seedTag];
      used.add(i);
      const seed = embeddings[i]!;
      const seedNeg = isNegated(normalizeTag(seedTag));
      for (let j = i + 1; j < embedCandidates.length; j++) {
        if (used.has(j)) continue;
        const other = embedCandidates[j]!;
        if (isNegated(normalizeTag(other)) !== seedNeg) continue;
        if (cosine(seed, embeddings[j]!) >= CLUSTER_THRESHOLD) {
          cluster.push(other);
          used.add(j);
        }
      }
      embedClusters.push(cluster);
    }

    // Replace singleton clusters that were embed-candidates with embed results
    const embedTagSet = new Set(embedCandidates);
    const kept = clusters.filter(
      (c) => !(c.length === 1 && embedTagSet.has(c[0]!)),
    );
    clusters.length = 0;
    clusters.push(...kept, ...embedClusters);
  }

  const rawToCanonical = new Map<string, string>();
  const vocabRows: {
    bookId: string;
    rawTag: string;
    canonicalTag: string;
    claimCount: number;
  }[] = [];

  for (const members of clusters) {
    const canonical = pickCanonical(members, tagCounts);
    for (const raw of members) {
      rawToCanonical.set(raw, canonical);
      vocabRows.push({
        bookId,
        rawTag: raw,
        canonicalTag: canonical,
        claimCount: tagCounts.get(raw) || 0,
      });
    }
  }

  // Any surface tag that somehow missed clustering maps to itself
  for (const tag of distinct) {
    if (!rawToCanonical.has(tag)) {
      rawToCanonical.set(tag, tag);
      vocabRows.push({
        bookId,
        rawTag: tag,
        canonicalTag: tag,
        claimCount: tagCounts.get(tag) || 0,
      });
    }
  }

  assertNoNegationCrossMerge(rawToCanonical);

  for (let i = 0; i < vocabRows.length; i += 200) {
    await wdb.insert(conceptVocab).values(vocabRows.slice(i, i + 200));
  }

  for (const row of rows) {
    const tags = claimTags.get(row.claimId) || [];
    const canonical = [
      ...new Set(tags.map((t) => rawToCanonical.get(t) || t)),
    ];
    await wdb
      .update(claims)
      .set({ canonicalConcepts: canonical })
      .where(eq(claims.claimId, row.claimId));
  }

  const canonicalCount = new Set(rawToCanonical.values()).size;
  const embedMerges = clusters.filter((c) => c.length > 1).length;

  await markStageDone(wdb, bookId, "canonicalize", {
    rawTagCount: distinct.length,
    canonicalTagCount: canonicalCount,
    clusterCount: clusters.length,
    multiTagClusters: embedMerges,
    negationBlocks: 0,
    embedThreshold: CLUSTER_THRESHOLD,
  });

  return { bookId, stage: "concepts", payload: {} } satisfies NewJob;
};
