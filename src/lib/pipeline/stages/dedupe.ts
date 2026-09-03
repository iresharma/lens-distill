import { and, eq, isNull, sql } from "drizzle-orm";
import { claims, type Claim, type NewJob } from "@/db/schema";
import { claudeMessages, embedTexts, getClaudeClient } from "@/lib/llm/client";
import { emitMerge } from "@/lib/llm/tools";
import { loadPrompt } from "@/lib/llm/prompts/load";
import { requireToolUse } from "@/lib/llm/require-tool";
import { cosine, projectTo2D } from "@/lib/math/pca2d";
import { recordStageUsage } from "@/lib/llm/record-usage";
import { stageRuns } from "@/db/schema";
import { markStageDone, markStageRunning, patchStageMetrics } from "../stage-runs";
import type { JobPayload, StageHandler } from "../types";
import { context } from "@/lib/otel/tracer";
import { otelLog } from "@/lib/otel/logger";

async function readMetrics(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
): Promise<Record<string, unknown>> {
  const [row] = await wdb
    .select({ metrics: stageRuns.metrics })
    .from(stageRuns)
    .where(and(eq(stageRuns.bookId, bookId), eq(stageRuns.stage, "dedupe")))
    .limit(1);
  return (row?.metrics || {}) as Record<string, unknown>;
}

/** Snapshot extract totals once; final stats always come from DB counts. */
async function ensureBaseline(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
) {
  const prev = await readMetrics(wdb, bookId);
  if (prev.claimsExtracted != null) return prev;

  const [stats] = await wdb
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where superseded is null)::int`,
    })
    .from(claims)
    .where(eq(claims.bookId, bookId));

  const baseline = {
    claimsExtracted: stats?.total ?? 0,
    claimsBefore: stats?.live ?? 0,
  };
  await patchStageMetrics(wdb, bookId, "dedupe", baseline);
  return { ...prev, ...baseline };
}

async function finishDedupe(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
  extras: Record<string, unknown>,
) {
  const prev = await readMetrics(wdb, bookId);
  const [stats] = await wdb
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where superseded is null)::int`,
      superseded: sql<number>`count(*) filter (where superseded is not null)::int`,
    })
    .from(claims)
    .where(eq(claims.bookId, bookId));

  const claimsExtracted = Number(prev.claimsExtracted ?? stats?.total ?? 0);
  const claimsBefore = Number(prev.claimsBefore ?? claimsExtracted);
  const claimsAfter = stats?.live ?? 0;
  const mergesPerformed = stats?.superseded ?? claimsBefore - claimsAfter;

  await markStageDone(wdb, bookId, "dedupe", {
    ...extras,
    claimsExtracted,
    claimsBefore,
    claimsAfter,
    mergesPerformed,
    claimsMergedAway: mergesPerformed,
    // drop stale per-invocation keys from older code
    mergesThisInvocation: undefined,
    multiClaimClustersPending: undefined,
    llmPending: undefined,
  });
  otelLog.info("dedupe stage done", {
    scope: "pipeline",
    bookId,
    stage: "dedupe",
    claimsBefore,
    claimsAfter,
    mergesPerformed,
  });
}

/** Cluster membership threshold (same as before). */
const SIM_THRESHOLD = 0.86;
/**
 * At/above this, skip Sonnet — statements are near-paraphrases; keep the best
 * wording deterministically. This is what made VC-prep feel fast in practice
 * relative to LLM-merging every pair.
 */
const AUTO_MERGE_THRESHOLD = 0.92;
const EMBED_BATCH = 100;
/** LLM merges per drain invocation (was 6). */
const LLM_MERGE_BATCH = 24;
/** Parallel Sonnet merge calls. */
const LLM_CONCURRENCY = 6;

function modeValue<T extends string>(vals: T[]): T {
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

function meanVector(vecs: number[][]): number[] {
  const dim = vecs[0]!.length;
  const out = new Array(dim).fill(0) as number[];
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i]! /= vecs.length;
  return out;
}

type EmbClaim = Claim & { embedding: number[] };

/**
 * Union-find clustering via 1D projection windows + cosine.
 * ~O(n · W · d) instead of repeated full-set centroid growth scans.
 */
function findClusters(active: EmbClaim[]): EmbClaim[][] {
  const n = active.length;
  if (!n) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Random-ish fixed projection for locality (deterministic seed)
  const dim = active[0]!.embedding.length;
  const projDir = new Array(dim) as number[];
  let s = 42;
  for (let i = 0; i < dim; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    projDir[i] = s / 0xffffffff - 0.5;
  }
  const scored = active.map((c, i) => {
    let p = 0;
    const e = c.embedding;
    for (let j = 0; j < dim; j++) p += e[j]! * projDir[j]!;
    return { i, p };
  });
  scored.sort((a, b) => a.p - b.p);

  // Window: compare each claim to the next W neighbors on the projection
  const W = Math.min(48, n - 1);
  for (let a = 0; a < n; a++) {
    const ia = scored[a]!.i;
    const ea = active[ia]!.embedding;
    for (let b = a + 1; b <= a + W && b < n; b++) {
      const ib = scored[b]!.i;
      if (cosine(ea, active[ib]!.embedding) >= SIM_THRESHOLD) {
        unite(ia, ib);
      }
    }
  }

  const groups = new Map<number, EmbClaim[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(active[i]!);
    groups.set(r, list);
  }
  return [...groups.values()];
}

function clusterTightness(cluster: EmbClaim[]): number {
  if (cluster.length < 2) return 1;
  const centroid = meanVector(cluster.map((c) => c.embedding));
  let min = 1;
  for (const c of cluster) {
    min = Math.min(min, cosine(centroid, c.embedding));
  }
  return min;
}

/** Prefer definition > mechanic > … then longer statement. */
function pickCanonical(cluster: EmbClaim[]): EmbClaim {
  const rank: Record<string, number> = {
    definition: 0,
    mechanic: 1,
    heuristic: 2,
    market_norm: 3,
    negotiation_move: 4,
    warning: 5,
    anecdote: 6,
  };
  return [...cluster].sort((a, b) => {
    const ra = rank[a.claimType] ?? 50;
    const rb = rank[b.claimType] ?? 50;
    if (ra !== rb) return ra - rb;
    return b.statement.length - a.statement.length;
  })[0]!;
}

async function applyMerge(
  wdb: Parameters<StageHandler>[1],
  cluster: EmbClaim[],
  merged: {
    statement: string;
    type?: string;
    favors?: string;
    concepts?: string[];
  },
  /** Keep a vector so we don't re-embed every round. */
  keepEmbedding: number[],
) {
  const canonical = pickCanonical(cluster);
  const clusterId = canonical.claimId;
  const supportParas = [
    ...new Set(cluster.flatMap((c) => c.supportParas)),
  ].sort((a, b) => a - b);
  const conceptsUnion = [
    ...new Set([
      ...cluster.flatMap((c) => c.concepts),
      ...(merged.concepts || []),
    ]),
  ];
  const sourceChunks = [...new Set(cluster.flatMap((c) => c.sourceChunks))];

  await wdb
    .update(claims)
    .set({
      statement: merged.statement.slice(0, 300),
      claimType: (merged.type ||
        modeValue(cluster.map((c) => c.claimType))) as Claim["claimType"],
      favors: (merged.favors ||
        modeValue(
          cluster.map((c) => c.favors || "not_applicable"),
        )) as Claim["favors"],
      concepts: conceptsUnion,
      supportParas,
      sourceChunks,
      clusterId,
      embedding: keepEmbedding,
    })
    .where(eq(claims.claimId, canonical.claimId));

  for (const loser of cluster) {
    if (loser.claimId === canonical.claimId) continue;
    await wdb
      .update(claims)
      .set({ superseded: canonical.claimId, clusterId })
      .where(eq(claims.claimId, loser.claimId));
  }
}

async function assignClustersAndProject(
  wdb: Parameters<StageHandler>[1],
  bookId: string,
) {
  const all = await wdb
    .select()
    .from(claims)
    .where(eq(claims.bookId, bookId));

  const live = all.filter(
    (c) => !c.superseded && c.embedding,
  ) as EmbClaim[];
  const clusters = findClusters(live);

  for (const cluster of clusters) {
    const clusterId = pickCanonical(cluster).claimId;
    for (const c of cluster) {
      await wdb
        .update(claims)
        .set({ clusterId })
        .where(eq(claims.claimId, c.claimId));
    }
  }

  for (const c of all) {
    if (!c.superseded) continue;
    const [winner] = await wdb
      .select({ clusterId: claims.clusterId })
      .from(claims)
      .where(eq(claims.claimId, c.superseded))
      .limit(1);
    if (winner?.clusterId) {
      await wdb
        .update(claims)
        .set({ clusterId: winner.clusterId })
        .where(eq(claims.claimId, c.claimId));
    }
  }

  const withEmb = await wdb
    .select()
    .from(claims)
    .where(and(eq(claims.bookId, bookId), sql`${claims.embedding} IS NOT NULL`));

  if (withEmb.length) {
    const vectors = withEmb.map((c) => c.embedding as number[]);
    const coords = projectTo2D(vectors);
    for (let i = 0; i < withEmb.length; i++) {
      await wdb
        .update(claims)
        .set({ projX: coords[i]!.x, projY: coords[i]!.y })
        .where(eq(claims.claimId, withEmb[i]!.claimId));
    }
  }

  return {
    clusterCount: clusters.length,
    multiClusters: clusters.filter((c) => c.length > 1).length,
    projected: withEmb.length,
  };
}

export const dedupeStage: StageHandler = async (job, wdb, deadline) => {
  const bookId = job.bookId;
  const payload = (job.payload || {}) as JobPayload;
  await markStageRunning(wdb, bookId, "dedupe");
  otelLog.info("dedupe stage running", { scope: "pipeline", bookId, stage: "dedupe" });
  const baseline = await ensureBaseline(wdb, bookId);

  // Phase A: embed any missing (large batches)
  while (Date.now() < deadline - 30_000) {
    const missing = await wdb
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.bookId, bookId),
          isNull(claims.superseded),
          isNull(claims.embedding),
        ),
      )
      .limit(EMBED_BATCH);
    if (!missing.length) break;

    const texts = missing.map((c) => c.statement);
    const { vectors, inputTokens } = await embedTexts(texts);
    const { models } = await getClaudeClient();
    await recordStageUsage(
      wdb,
      bookId,
      "dedupe",
      models.embed,
      inputTokens,
      0,
      1,
    );
    for (let j = 0; j < missing.length; j++) {
      await wdb
        .update(claims)
        .set({ embedding: vectors[j]! })
        .where(eq(claims.claimId, missing[j]!.claimId));
    }
  }

  const activeRows = await wdb
    .select()
    .from(claims)
    .where(and(eq(claims.bookId, bookId), isNull(claims.superseded)));

  if (!activeRows.length) {
    await finishDedupe(wdb, bookId, {
      simThreshold: SIM_THRESHOLD,
      note: "no live claims",
    });
    return { bookId, stage: "canonicalize", payload: {} } satisfies NewJob;
  }

  if (activeRows.some((c) => !c.embedding)) {
    return {
      bookId,
      stage: "dedupe",
      payload: { cursor: (payload.cursor ?? 0) + 1 },
    } satisfies NewJob;
  }

  const active = activeRows as EmbClaim[];
  const clusters = findClusters(active);
  const multi = clusters.filter((c) => c.length > 1);

  if (!multi.length) {
    const proj = await assignClustersAndProject(wdb, bookId);
    await finishDedupe(wdb, bookId, {
      multiClaimClusters: 0,
      simThreshold: SIM_THRESHOLD,
      autoMergeThreshold: AUTO_MERGE_THRESHOLD,
      autoMergesTotal: Number(baseline.autoMergesTotal ?? 0),
      llmMergesTotal: Number(baseline.llmMergesTotal ?? 0),
      ...proj,
    });
    return { bookId, stage: "canonicalize", payload: {} } satisfies NewJob;
  }

  // Phase B: auto-merge tight clusters (no LLM)
  let autoMerges = 0;
  const needsLlm: EmbClaim[][] = [];

  for (const cluster of multi) {
    const tightness = clusterTightness(cluster);
    if (tightness >= AUTO_MERGE_THRESHOLD) {
      const canonical = pickCanonical(cluster);
      await applyMerge(
        wdb,
        cluster,
        {
          statement: canonical.statement,
          type: canonical.claimType,
          favors: canonical.favors ?? "not_applicable",
          concepts: [
            ...new Set(cluster.flatMap((c) => c.concepts)),
          ],
        },
        meanVector(cluster.map((c) => c.embedding)),
      );
      autoMerges++;
    } else {
      needsLlm.push(cluster);
    }
  }

  // Phase C: parallel Sonnet merges for borderline clusters
  let llmMerges = 0;
  if (needsLlm.length && Date.now() < deadline - 25_000) {
    const { models } = await getClaudeClient();
    const system = loadPrompt("merge");
    const batch = needsLlm.slice(0, LLM_MERGE_BATCH);
    const queue = [...batch];
    const parentCtx = context.active();

    const workers = Array.from({ length: LLM_CONCURRENCY }, async () => {
      while (queue.length && Date.now() < deadline - 20_000) {
        const cluster = queue.shift();
        if (!cluster) return;

        const res = await context.with(parentCtx, () =>
          claudeMessages({
            model: models.merge,
            max_tokens: 1024,
            system,
            tools: [emitMerge],
            tool_choice: { type: "tool", name: "emit_merge" },
            messages: [
              {
                role: "user",
                content: cluster
                  .map((c) => `- (${c.claimType}/${c.favors}) ${c.statement}`)
                  .join("\n"),
              },
            ],
          }),
        );

        const { models: active } = await getClaudeClient();
        await recordStageUsage(
          wdb,
          bookId,
          "dedupe",
          active.merge,
          res.usage?.input_tokens ?? 0,
          res.usage?.output_tokens ?? 0,
          1,
        );

        const toolBlock = requireToolUse(res, "dedupe");
        const merged = toolBlock.input as {
          statement: string;
          type: string;
          favors: string;
          concepts: string[];
        };

        await applyMerge(
          wdb,
          cluster,
          merged,
          meanVector(cluster.map((c) => c.embedding)),
        );
        llmMerges++;
      }
    });

    await Promise.all(workers);
  }

  const prev = await readMetrics(wdb, bookId);
  const { models: mergeModels } = await getClaudeClient();
  await patchStageMetrics(wdb, bookId, "dedupe", {
    autoMergesTotal: Number(prev.autoMergesTotal ?? 0) + autoMerges,
    llmMergesTotal: Number(prev.llmMergesTotal ?? 0) + llmMerges,
    lastInvocation: {
      autoMerges,
      llmMerges,
      multiClaimClustersSeen: multi.length,
      llmPending: Math.max(0, needsLlm.length - llmMerges),
    },
    simThreshold: SIM_THRESHOLD,
    autoMergeThreshold: AUTO_MERGE_THRESHOLD,
    model: mergeModels.merge,
  });
  otelLog.info("dedupe merge pass complete", {
    scope: "pipeline",
    bookId,
    stage: "dedupe",
    autoMerges,
    llmMerges,
    multiClaimClustersSeen: multi.length,
    llmPending: Math.max(0, needsLlm.length - llmMerges),
  });

  // More borderline clusters left?
  if (needsLlm.length > llmMerges) {
    return {
      bookId,
      stage: "dedupe",
      payload: { cursor: (payload.cursor ?? 0) + 1 },
    } satisfies NewJob;
  }

  // Auto-merges may have unlocked new pairs — one more pass if we still have time
  if (autoMerges > 0 && Date.now() < deadline - 40_000) {
    return {
      bookId,
      stage: "dedupe",
      payload: { cursor: (payload.cursor ?? 0) + 1 },
    } satisfies NewJob;
  }

  // Verify clean
  const still = (await wdb
    .select()
    .from(claims)
    .where(
      and(eq(claims.bookId, bookId), isNull(claims.superseded)),
    )) as EmbClaim[];
  const stillMulti = findClusters(
    still.filter((c) => c.embedding) as EmbClaim[],
  ).filter((c) => c.length > 1);

  if (stillMulti.length) {
    return {
      bookId,
      stage: "dedupe",
      payload: { cursor: (payload.cursor ?? 0) + 1 },
    } satisfies NewJob;
  }

  const proj = await assignClustersAndProject(wdb, bookId);
  const latest = await readMetrics(wdb, bookId);
  const { models: doneModels } = await getClaudeClient();
  await finishDedupe(wdb, bookId, {
    simThreshold: SIM_THRESHOLD,
    autoMergeThreshold: AUTO_MERGE_THRESHOLD,
    autoMergesTotal: Number(latest.autoMergesTotal ?? 0),
    llmMergesTotal: Number(latest.llmMergesTotal ?? 0),
    model: doneModels.merge,
    ...proj,
  });

  return { bookId, stage: "canonicalize", payload: {} } satisfies NewJob;
};
