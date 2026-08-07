import type { ReactNode } from "react";

type StageMeta = {
  id: string;
  label: string;
  hint: string;
  color: string;
  bg: string;
  ring: string;
  /** Generative model call (Haiku / Sonnet / Opus) — not embeddings. */
  llm?: boolean;
  Icon: () => ReactNode;
};

const STAGES: StageMeta[] = [
  {
    id: "chunk",
    label: "chunk",
    hint: "Split by chapter",
    color: "#38bdf8",
    bg: "bg-sky-500/15",
    ring: "ring-sky-400/35",
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d="M4 7h16M4 12h10M4 17h14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "embed",
    label: "embed",
    hint: "1536-d vectors",
    color: "#2dd4bf",
    bg: "bg-teal-500/15",
    ring: "ring-teal-400/35",
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <circle cx="8" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="16" cy="8" r="2" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="16" cy="16" r="2" stroke="currentColor" strokeWidth="1.75" />
        <path
          d="M10.2 11.2 14.2 9M10.2 12.8l4 2.4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "extract",
    label: "extract",
    hint: "Persona claims",
    color: "#a78bfa",
    bg: "bg-violet-500/15",
    ring: "ring-violet-400/40",
    llm: true,
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d="M7 4h7l4 4v12H7V4Z"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M14 4v4h4M9 13h6M9 16h4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "dedupe",
    label: "dedupe",
    hint: "Merge near-twins",
    color: "#fbbf24",
    bg: "bg-amber-500/15",
    ring: "ring-amber-400/35",
    llm: true,
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <rect
          x="4"
          y="6"
          width="10"
          height="12"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <rect
          x="10"
          y="6"
          width="10"
          height="12"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.75"
          opacity="0.7"
        />
      </svg>
    ),
  },
  {
    id: "canonicalize",
    label: "canonicalize",
    hint: "Unify tags",
    color: "#fb7185",
    bg: "bg-rose-500/15",
    ring: "ring-rose-400/35",
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <path
          d="M12 4v4M12 16v4M4 12h4M16 12h4"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.75" />
      </svg>
    ),
  },
  {
    id: "concepts",
    label: "concepts",
    hint: "Nodes ≥ threshold",
    color: "#34d399",
    bg: "bg-emerald-500/15",
    ring: "ring-emerald-400/35",
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <circle cx="12" cy="7.5" r="2.75" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="7" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="17" cy="16.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <path
          d="M10.5 9.5 8.2 14.2M13.5 9.5l2.3 4.7"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    id: "graph",
    label: "graph",
    hint: "Edges + kinds",
    color: "#818cf8",
    bg: "bg-indigo-500/15",
    ring: "ring-indigo-400/35",
    llm: true,
    Icon: () => (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
        <circle cx="6" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="18" cy="6.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <circle cx="18" cy="17.5" r="2.5" stroke="currentColor" strokeWidth="1.75" />
        <path
          d="M8.3 11 15.5 7.5M8.3 13l7.2 3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export function PipelineStrip() {
  const last = STAGES.length - 1;

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#0e1016]/85 px-4 py-5 backdrop-blur sm:px-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-wider text-white/40">
          Pipeline
        </p>
        <p className="flex items-center gap-1.5 text-[11px] text-white/35">
          <span className="rounded bg-violet-500/20 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-violet-200 ring-1 ring-violet-400/30">
            LLM
          </span>
          = Haiku / Sonnet / Opus
        </p>
      </div>

      <ol className="flex min-w-[640px] sm:min-w-0">
        {STAGES.map((stage, i) => (
          <li key={stage.id} className="flex min-w-0 flex-1 flex-col items-center">
            {/* Equal columns: line · bubble · line — lines never run under the icon */}
            <div className="flex h-11 w-full items-center">
              {i === 0 ? (
                <span className="flex-1" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className="h-0.5 flex-1 rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${STAGES[i - 1]!.color}99, ${stage.color}99)`,
                  }}
                />
              )}

              <span
                className={`relative z-[1] flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ring-1 ${stage.bg} ${stage.ring}`}
                style={{ color: stage.color }}
                title={stage.llm ? `${stage.hint} · uses LLM` : stage.hint}
              >
                <stage.Icon />
                {stage.llm ? (
                  <span className="absolute -right-1.5 -top-1.5 rounded bg-[#1a1030] px-1 py-px font-mono text-[8px] font-semibold uppercase leading-none tracking-wide text-violet-200 ring-1 ring-violet-400/50">
                    LLM
                  </span>
                ) : null}
              </span>

              {i === last ? (
                <span className="flex-1" aria-hidden />
              ) : (
                <span
                  aria-hidden
                  className="h-0.5 flex-1 rounded-full"
                  style={{
                    background: `linear-gradient(90deg, ${stage.color}99, ${STAGES[i + 1]!.color}99)`,
                  }}
                />
              )}
            </div>

            <div className="mt-2 flex h-[2.75rem] w-full flex-col items-center px-1 text-center">
              <p
                className="font-mono text-[11px] font-medium leading-tight"
                style={{ color: stage.color }}
              >
                {stage.label}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-white/30">
                {stage.hint}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
