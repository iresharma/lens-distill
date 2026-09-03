import { eq, asc } from "drizzle-orm";
import { getEncoding } from "js-tiktoken";
import { books, chunks, paragraphs, type NewJob } from "@/db/schema";
import { markStageDone, markStageRunning } from "../stage-runs";
import type { JobPayload, StageHandler } from "../types";
import { otelLog } from "@/lib/otel/logger";

const TARGET = 1200;
const MIN_TOKENS = 600;
const OVERLAP = 150;
const SECTION_SOFT_WINDOW = 300;
/** Raised for long demo books (e.g. Nature of Code ~640 pp). */
const MAX_CHUNKS = 550;

export const chunkStage: StageHandler = async (job, wdb) => {
  const bookId = job.bookId;
  await markStageRunning(wdb, bookId, "chunk");
  otelLog.info("chunk stage running", { scope: "pipeline", bookId, stage: "chunk" });
  await wdb
    .update(books)
    .set({ status: "running" })
    .where(eq(books.bookId, bookId));
  await wdb.delete(chunks).where(eq(chunks.bookId, bookId));

  const paras = await wdb
    .select()
    .from(paragraphs)
    .where(eq(paragraphs.bookId, bookId))
    .orderBy(asc(paragraphs.paraIndex));

  if (!paras.length) {
    throw new Error(`No paragraphs for book ${bookId}`);
  }

  const chapters = new Set(
    paras.map((p) => p.chapterIndex).filter((c): c is number => c != null),
  );

  const enc = getEncoding("cl100k_base");
  const tokenOf = (t: string) => enc.encode(t).length;
  const paraTokens = paras.map((p) => tokenOf(p.text));

  type Slice = { start: number; end: number };
  const slices: Slice[] = [];

  let start = 0;
  while (start < paras.length) {
    let end = start;
    let tokens = 0;
    let softBreak: number | null = null;

    while (end < paras.length) {
      if (
        end > start &&
        paras[end]!.chapterIndex !== paras[start]!.chapterIndex
      ) {
        break;
      }

      const nextTok = paraTokens[end]!;
      if (tokens + nextTok > TARGET && end > start) break;

      if (
        end > start &&
        paras[end]!.sectionTitle !== paras[end - 1]!.sectionTitle &&
        paras[end]!.sectionTitle != null
      ) {
        softBreak = end;
      }

      tokens += nextTok;
      end++;
    }

    let cut = end;
    if (softBreak != null && softBreak > start) {
      let afterSoft = 0;
      for (let i = softBreak; i < end; i++) afterSoft += paraTokens[i]!;
      if (afterSoft < SECTION_SOFT_WINDOW) cut = softBreak;
    }

    if (cut <= start) cut = Math.min(start + 1, paras.length);
    slices.push({ start, end: cut - 1 });

    if (cut >= paras.length) break;

    let overlapTok = 0;
    let nextStart = cut;
    for (let i = cut - 1; i > start; i--) {
      if (overlapTok >= OVERLAP) break;
      overlapTok += paraTokens[i]!;
      nextStart = i;
    }
    start = Math.max(nextStart, start + 1);
  }

  const sliceTokens = (s: Slice) => {
    let n = 0;
    for (let i = s.start; i <= s.end; i++) n += paraTokens[i]!;
    return n;
  };

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < slices.length - 1; i++) {
      const a = slices[i]!;
      const b = slices[i + 1]!;
      if (paras[a.start]!.chapterIndex !== paras[b.start]!.chapterIndex) {
        continue;
      }
      const combined = sliceTokens(a) + sliceTokens(b);
      if (
        (sliceTokens(a) < MIN_TOKENS || sliceTokens(b) < MIN_TOKENS) &&
        combined <= TARGET
      ) {
        slices[i] = { start: a.start, end: b.end };
        slices.splice(i + 1, 1);
        merged = true;
        break;
      }
    }
  }

  const out = slices.map((s, chunkIndex) => {
    const slice = paras.slice(s.start, s.end + 1);
    const text = slice.map((p) => p.text).join("\n\n");
    const tokenCount = slice.reduce(
      (n, _, i) => n + paraTokens[s.start + i]!,
      0,
    );
    return {
      chunkId: `${bookId}:c${chunkIndex}`,
      bookId,
      chunkIndex,
      paraStart: slice[0]!.paraIndex,
      paraEnd: slice[slice.length - 1]!.paraIndex,
      chapterIndex: slice[0]!.chapterIndex,
      sectionTitle: slice[0]!.sectionTitle,
      pageStart: slice[0]!.page,
      pageEnd: slice[slice.length - 1]!.page,
      tokenCount,
      text,
    };
  });

  if (!out.length) throw new Error("Chunker produced zero chunks");
  if (out.length > MAX_CHUNKS) {
    throw new Error(
      `Book too large for demo: ${out.length} chunks (max ${MAX_CHUNKS}). Try a shorter PDF.`,
    );
  }

  const tokenCounts = out.map((c) => c.tokenCount);
  const avg = tokenCounts.reduce((n, t) => n + t, 0) / out.length;
  if (avg < TARGET * 0.5) {
    throw new Error(
      `Chunker produced avg ${Math.round(avg)} tokens (target ${TARGET}) — upstream chapter detection is likely broken`,
    );
  }

  await wdb.insert(chunks).values(out);

  const chunkDoneMetrics = {
    chapterCount: chapters.size,
    paragraphCount: paras.length,
    chunkCount: out.length,
    avgTokens: Math.round(avg),
    minTokens: Math.min(...tokenCounts),
    maxTokens: Math.max(...tokenCounts),
    targetTokens: TARGET,
    gate: "ok",
  };
  await markStageDone(wdb, bookId, "chunk", chunkDoneMetrics);
  otelLog.info("chunk stage done", {
    scope: "pipeline",
    bookId,
    stage: "chunk",
    ...chunkDoneMetrics,
  });

  const incoming = (job.payload || {}) as JobPayload;
  return {
    bookId,
    stage: "embed",
    payload: { cursor: 0, chapterOnly: incoming.chapterOnly },
  } satisfies NewJob;
};
