"use client";

import { useState } from "react";

export type TimelineStage = {
  stage: string;
  status: "pending" | "running" | "done" | "failed" | string;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: Record<string, unknown>;
  error: string | null;
};

const STAGE_META: Record<string, { title: string; blurb: string }> = {
  chunk: {
    title: "Chunk",
    blurb: "Split paragraphs into ~1200-token slices at chapter boundaries.",
  },
  embed: {
    title: "Embed",
    blurb: "Vectorize chunks (1536-d) for later similarity work.",
  },
  extract: {
    title: "Extract",
    blurb: "LLM emits typed claims with [pN] citations under your persona lens.",
  },
  dedupe: {
    title: "Dedupe",
    blurb: "Cluster near-duplicate claims (cosine ≥ 0.86) and merge with Sonnet.",
  },
  canonicalize: {
    title: "Canonicalize",
    blurb: "Normalize concept tags — string-first, embeddings last, negation guard.",
  },
  concepts: {
    title: "Concepts",
    blurb: "Promote tags with ≥8 claims into concept nodes.",
  },
  concept_graph: {
    title: "Concept graph",
    blurb: "LLM wires prerequisite / related / confusable edges.",
  },
};

function statusColor(status: string) {
  switch (status) {
    case "done":
      return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    case "running":
      return "bg-violet-500/20 text-violet-200 border-violet-500/40 animate-pulse";
    case "failed":
      return "bg-red-500/20 text-red-300 border-red-500/30";
    default:
      return "bg-white/5 text-white/45 border-white/10";
  }
}

function formatDuration(start: string | null, end: string | null) {
  if (!start) return null;
  const a = new Date(start).getTime();
  const b = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((b - a) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function MetricGrid({ metrics }: { metrics: Record<string, unknown> }) {
  const entries = Object.entries(metrics);
  if (!entries.length) {
    return <p className="text-sm text-white/40">No metrics yet.</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="truncate text-[10px] uppercase tracking-wider text-white/40">
            {k}
          </dt>
          <dd className="truncate text-sm text-white/85">
            {typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DistillTimeline({ stages }: { stages: TimelineStage[] }) {
  const [open, setOpen] = useState<string | null>(
    stages.find((s) => s.status === "running")?.stage ??
      stages.find((s) => s.status === "failed")?.stage ??
      null,
  );

  return (
    <ol className="space-y-2">
      {stages.map((s, i) => {
        const meta = STAGE_META[s.stage] ?? {
          title: s.stage,
          blurb: "",
        };
        const isOpen = open === s.stage;
        const dur = formatDuration(s.startedAt, s.finishedAt);
        return (
          <li
            key={s.stage}
            className="rounded-xl border border-white/10 bg-[#12141a]"
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : s.stage)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 text-xs text-white/60">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{meta.title}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${statusColor(s.status)}`}
                  >
                    {s.status}
                  </span>
                  {dur ? (
                    <span className="text-[11px] text-white/40">{dur}</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-sm text-white/50">{meta.blurb}</p>
              </div>
              <span className="text-white/35">{isOpen ? "−" : "+"}</span>
            </button>
            {isOpen ? (
              <div className="border-t border-white/8 px-4 py-3 pl-14">
                {s.error ? (
                  <p className="mb-3 text-sm text-red-300">{s.error}</p>
                ) : null}
                <MetricGrid metrics={s.metrics} />
                <details className="mt-3">
                  <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-white/35">
                    Raw metrics JSON
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] text-white/60">
                    {JSON.stringify(s.metrics, null, 2)}
                  </pre>
                </details>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
