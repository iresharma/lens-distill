"use client";

import type { TimelineStage } from "@/components/DistillTimeline";
import type { UsageRollup } from "@/lib/llm/pricing";

export type LiveCounts = {
  paragraphs: number;
  chunks: number;
  liveClaims: number;
  allClaims: number;
  supersededClaims: number;
  concepts: number;
  edges: number;
};

function progressFromStages(stages: TimelineStage[]) {
  if (!stages.length) return 0;
  let score = 0;
  for (const s of stages) {
    if (s.status === "done") score += 1;
    else if (s.status === "running") score += 0.45;
    else if (s.status === "failed") score += 0.15;
  }
  return Math.min(100, Math.round((score / stages.length) * 100));
}

function Ring({ pct, running }: { pct: number; running: boolean }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c;
  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="8"
        />
        <circle
          cx="64"
          cy="64"
          r={r}
          fill="none"
          stroke={running ? "#8b7cff" : "#4cb782"}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums text-white">
          {pct}%
        </span>
        <span className="text-[10px] uppercase tracking-wider text-white/40">
          {running ? "running" : pct >= 100 ? "ready" : "progress"}
        </span>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0c0e12] px-3 py-3">
      <p className="text-[10px] uppercase tracking-wider text-white/40">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-white">
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-white/35">{hint}</p> : null}
    </div>
  );
}

function fmtUsd(n: number) {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTok(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function DistillProgress({
  title,
  authors,
  status,
  stages,
  counts,
  usage,
}: {
  title: string;
  authors: string[];
  status: string;
  stages: TimelineStage[];
  counts: LiveCounts;
  usage: UsageRollup;
}) {
  const pct = progressFromStages(stages);
  const running = status === "queued" || status === "running";
  const current =
    stages.find((s) => s.status === "running") ??
    stages.find((s) => s.status === "failed") ??
    stages.filter((s) => s.status === "done").at(-1);
  const models = Object.values(usage.byModel).sort(
    (a, b) => b.estimatedUsd - a.estimatedUsd,
  );

  return (
    <div className="rounded-2xl border border-white/10 bg-[#12141a] p-5">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <Ring pct={pct} running={running} />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-white/40">
            Distilling
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-white">
            {title}
          </h2>
          <p className="text-sm text-white/50">{authors.join(", ")}</p>
          <p className="mt-3 text-sm text-white/65">
            {current ? (
              <>
                Stage{" "}
                <span className="text-violet-200">{current.stage}</span>
                {" · "}
                <span className="text-white/45">{current.status}</span>
              </>
            ) : (
              "Waiting to start"
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {stages.map((s) => (
              <span
                key={s.stage}
                className={`h-1.5 w-8 rounded-full ${
                  s.status === "done"
                    ? "bg-emerald-400/80"
                    : s.status === "running"
                      ? "bg-violet-400 animate-pulse"
                      : s.status === "failed"
                        ? "bg-red-400/80"
                        : "bg-white/10"
                }`}
                title={`${s.stage}: ${s.status}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi
          label="Live claims"
          value={String(counts.liveClaims)}
          hint={
            counts.supersededClaims
              ? `${counts.supersededClaims} merged away`
              : `${counts.allClaims} extracted`
          }
        />
        <Kpi
          label="Chunks"
          value={String(counts.chunks)}
          hint={`${counts.paragraphs.toLocaleString()} paragraphs`}
        />
        <Kpi
          label="Concepts"
          value={String(counts.concepts)}
          hint={counts.edges ? `${counts.edges} edges` : "after concepts stage"}
        />
        <Kpi
          label="Est. billed"
          value={fmtUsd(usage.estimatedUsd)}
          hint={
            usage.includesEstimates
              ? "includes estimates · list prices"
              : `${usage.calls} API calls · list prices`
          }
        />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-[#0c0e12] px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            Tokens
          </p>
          <div className="mt-2 flex gap-6">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-white">
                {fmtTok(usage.inputTokens)}
              </p>
              <p className="text-[11px] text-white/40">in</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-white">
                {fmtTok(usage.outputTokens)}
              </p>
              <p className="text-[11px] text-white/40">out</p>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-[#0c0e12] px-4 py-3">
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            By model
          </p>
          {models.length ? (
            <ul className="mt-2 space-y-2">
              {models.map((m) => (
                <li
                  key={m.model}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="truncate font-mono text-[11px] text-white/70">
                    {m.model.replace(/^claude-/, "").replace(/^openai\//, "")}
                  </span>
                  <span className="shrink-0 tabular-nums text-white/85">
                    {m.model.includes("embedding")
                      ? `${fmtTok(m.inputTokens)} in · ${fmtUsd(m.estimatedUsd)}`
                      : `${fmtTok(m.inputTokens)}/${fmtTok(m.outputTokens)} · ${fmtUsd(m.estimatedUsd)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-white/40">
              Token logs appear as LLM stages run. Earlier stages may show
              estimates from chunk sizes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
