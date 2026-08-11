"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BookGraphTab } from "@/components/BookGraphTab";
import {
  DistillProgress,
  type LiveCounts,
} from "@/components/DistillProgress";
import { DistillTimeline, type TimelineStage } from "@/components/DistillTimeline";
import { EmbeddingClusterView } from "@/components/EmbeddingClusterView";
import type { UsageRollup } from "@/lib/llm/pricing";

type Tab = "timeline" | "concepts" | "claims" | "graph" | "embeddings" | "persona";

type BookPayload = {
  book: {
    bookId: string;
    title: string;
    authors: string[];
    status: string;
    statusError: string | null;
    extractPrompt: string;
  };
  timeline: TimelineStage[];
  concepts: {
    conceptId: string;
    label: string;
    oneLiner: string;
    claimCount: number;
    primaryChapter: number | null;
  }[];
  liveClaims: number;
  counts: LiveCounts;
  usage: UsageRollup;
};

export function BookClient({ bookId }: { bookId: string }) {
  const search = useSearchParams();
  const initialTab = (search.get("tab") as Tab) || "timeline";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [data, setData] = useState<BookPayload | null>(null);
  const [claims, setClaims] = useState<
    {
      claimId: string;
      statement: string;
      claimType: string;
      concepts: string[];
      supportParas: number[];
    }[]
  >([]);
  const [expanded, setExpanded] = useState<{
    claimId: string;
    paragraphs: {
      paraIndex: number;
      chapterTitle: string | null;
      text: string;
    }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/books/${bookId}`, { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load book (${res.status})`);
        return;
      }
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load book");
    }
  }, [bookId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pipelineLive =
    data?.book.status === "queued" || data?.book.status === "running";

  useEffect(() => {
    if (!pipelineLive) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [pipelineLive, refresh]);

  useEffect(() => {
    if (tab !== "claims") return;
    const concept = search.get("concept");
    const q = concept ? `?concept=${encodeURIComponent(concept)}` : "";
    void fetch(`/api/books/${bookId}/claims${q}`)
      .then((r) => r.json())
      .then((d) => setClaims(d.claims || []));
  }, [tab, bookId, search]);

  async function expandClaim(claimId: string) {
    const res = await fetch(
      `/api/books/${bookId}/claims?claimId=${encodeURIComponent(claimId)}`,
    );
    const d = await res.json();
    setExpanded({
      claimId,
      paragraphs: d.paragraphs || [],
    });
  }

  async function resumeThisBook() {
    setResuming(true);
    try {
      const res = await fetch("/api/pipeline/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookIds: [bookId] }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error || `Resume failed (${res.status})`);
        return;
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume failed");
    } finally {
      setResuming(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-3">
        <p className="text-red-300">{error}</p>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/80"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!data) {
    return <p className="text-white/50">Loading…</p>;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "timeline", label: "Timeline" },
    { id: "concepts", label: "Concepts" },
    { id: "claims", label: "Claims" },
    { id: "graph", label: "Graph" },
    { id: "embeddings", label: "Embeddings" },
    { id: "persona", label: "Persona" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <Link href="/" className="text-sm text-violet-300 hover:underline">
          ← Gallery
        </Link>
        <p className="mt-3 text-[11px] uppercase tracking-wider text-white/40">
          {data.book.status}
          {data.liveClaims ? ` · ${data.liveClaims} live claims` : ""}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">
          {data.book.title}
        </h1>
        <p className="mt-1 text-white/50">{data.book.authors.join(", ")}</p>
        {data.book.statusError ? (
          <div className="mt-3 space-y-2">
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {data.book.statusError}
            </p>
            {data.book.status === "failed" ? (
              <button
                type="button"
                disabled={resuming}
                onClick={() => void resumeThisBook()}
                className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#0a0a0b] disabled:opacity-50"
              >
                {resuming ? "Resuming…" : "Resume this book →"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-white/10 pb-px">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm ${
              tab === t.id
                ? "border-b-2 border-violet-400 text-white"
                : "text-white/45 hover:text-white/70"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "timeline" ? (
        <section className="space-y-6">
          <DistillProgress
            title={data.book.title}
            authors={data.book.authors}
            status={data.book.status}
            stages={data.timeline}
            counts={
              data.counts ?? {
                paragraphs: 0,
                chunks: 0,
                liveClaims: data.liveClaims,
                allClaims: data.liveClaims,
                supersededClaims: 0,
                concepts: data.concepts.length,
                edges: 0,
              }
            }
            usage={
              data.usage ?? {
                inputTokens: 0,
                outputTokens: 0,
                calls: 0,
                estimatedUsd: 0,
                byModel: {},
              }
            }
          />
          <div>
            <p className="mb-3 text-[11px] uppercase tracking-wider text-white/40">
              Stage timeline
            </p>
            <p className="mb-4 text-sm text-white/50">
              {data.book.status === "failed"
                ? "Pipeline stopped — use Resume above after fixing API limits."
                : "Observe-only while running — drain continues from upload or Resume."}
              {pipelineLive
                ? " Counts refresh every few seconds while running."
                : data.book.status === "ready"
                  ? " Pipeline finished — live refresh stopped."
                  : ""}
            </p>
            <DistillTimeline stages={data.timeline} />
          </div>
        </section>
      ) : null}

      {tab === "concepts" ? (
        <ul className="space-y-2">
          {data.concepts.map((c) => (
            <li
              key={c.conceptId}
              className="rounded-xl border border-white/10 bg-[#12141a] px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-white">{c.label}</p>
                <span className="text-[11px] text-white/40">
                  {c.claimCount} claims
                  {c.primaryChapter != null ? ` · ch ${c.primaryChapter}` : ""}
                </span>
              </div>
              <p className="mt-1 max-w-[68ch] text-sm text-white/60">
                {c.oneLiner}
              </p>
            </li>
          ))}
          {!data.concepts.length ? (
            <li className="text-sm text-white/40">
              Concepts appear after the concepts stage finishes.
            </li>
          ) : null}
        </ul>
      ) : null}

      {tab === "claims" ? (
        <ul className="space-y-3">
          {claims.map((c) => (
            <li
              key={c.claimId}
              className="rounded-xl border border-white/10 bg-[#12141a] px-4 py-3"
            >
              <p className="text-[10px] uppercase tracking-wider text-white/40">
                {c.claimType}
              </p>
              <p className="mt-1 max-w-[68ch] text-sm leading-relaxed text-white/90">
                {c.statement}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {c.supportParas.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => void expandClaim(c.claimId)}
                    className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-200"
                  >
                    ¶{p}
                  </button>
                ))}
              </div>
              {expanded?.claimId === c.claimId ? (
                <div className="mt-3 space-y-2 border-t border-white/8 pt-3">
                  {expanded.paragraphs.map((p) => (
                    <blockquote
                      key={p.paraIndex}
                      className="max-w-[68ch] border-l-2 border-violet-500/40 pl-3 text-sm text-white/65"
                    >
                      <span className="text-[10px] text-white/35">
                        ¶{p.paraIndex}
                        {p.chapterTitle ? ` · ${p.chapterTitle}` : ""}
                      </span>
                      <p className="mt-1">{p.text}</p>
                    </blockquote>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
          {!claims.length ? (
            <li className="text-sm text-white/40">
              Claims appear after extract (and shrink after dedupe).
            </li>
          ) : null}
        </ul>
      ) : null}

      {tab === "graph" ? (
        <BookGraphTab bookId={bookId} pipelineLive={!!pipelineLive} />
      ) : null}

      {tab === "embeddings" ? (
        data.book.status === "ready" ||
        data.timeline.some(
          (s) => s.stage === "dedupe" && s.status === "done",
        ) ? (
          <EmbeddingClusterView bookId={bookId} />
        ) : (
          <p className="text-sm text-white/40">
            Embedding projection is written at the end of dedupe.
          </p>
        )
      ) : null}

      {tab === "persona" ? (
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-[#12141a] p-4 font-mono text-xs leading-relaxed text-white/75">
          {data.book.extractPrompt}
        </pre>
      ) : null}
    </div>
  );
}
