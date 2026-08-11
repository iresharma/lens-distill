"use client";

import { useCallback, useEffect, useState } from "react";
import type { UsageSnapshot } from "@/lib/usage/providers";

function fmtUsd(n: number | null | undefined) {
  if (n == null) return "—";
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = !ok ? "bg-red-400" : warn ? "bg-amber-400" : "bg-teal-400";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color} ${!ok ? "pipeline-dot-live" : ""}`}
      aria-hidden
    />
  );
}

export function ApiLimitsBar() {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { cache: "no-store" });
      if (!res.ok) {
        setError(`Usage probe failed (${res.status})`);
        return;
      }
      setUsage((await res.json()) as UsageSnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Usage probe failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function resume() {
    setResuming(true);
    setResumeMsg(null);
    try {
      const res = await fetch("/api/pipeline/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        resetJobs?: number;
        resetBooks?: string[];
      };
      if (!res.ok || !json.ok) {
        setResumeMsg(json.error || `Resume failed (${res.status})`);
        return;
      }
      setResumeMsg(
        json.resetJobs
          ? `Reset ${json.resetJobs} job${json.resetJobs === 1 ? "" : "s"} — drain started`
          : "No failed jobs — drain kicked",
      );
      void refresh();
    } catch (e) {
      setResumeMsg(e instanceof Error ? e.message : "Resume failed");
    } finally {
      setResuming(false);
    }
  }

  const an = usage?.anthropic;
  const or = usage?.openrouter;
  const anthropicBlocked = Boolean(an?.configured && !an.ok);
  const usingFallback =
    anthropicBlocked && an?.transport === "openrouter" && Boolean(or?.ok);
  const orNearCap =
    or?.ok &&
    or.limitUsd != null &&
    or.limitRemainingUsd != null &&
    or.limitUsd > 0 &&
    or.limitRemainingUsd / or.limitUsd < 0.15;

  return (
    <div
      className={`rounded-2xl border px-4 py-4 sm:px-5 ${
        anthropicBlocked && !usingFallback
          ? "border-red-500/30 bg-red-500/[0.07]"
          : usingFallback || orNearCap
            ? "border-amber-500/30 bg-amber-500/[0.06]"
            : "border-white/10 bg-[#0e1016]/85"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-white/40">
            API limits
          </p>
          <p className="mt-1 text-sm text-white/55">
            {usingFallback
              ? "Anthropic capped — distill auto-switched Claude to OpenRouter."
              : anthropicBlocked
                ? "Claude path is blocked — pipelines will stall on extract/dedupe/graph."
                : orNearCap
                  ? "OpenRouter key is near its spend cap."
                  : "Provider headroom for distill calls."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-full border border-white/12 px-3 py-1.5 text-[11px] text-white/55 hover:border-white/25 hover:text-white/80"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={resuming}
            onClick={() => void resume()}
            className="rounded-full bg-white px-3 py-1.5 text-[11px] font-semibold text-[#0a0a0b] disabled:opacity-50"
          >
            {resuming ? "Resuming…" : "Resume failed jobs"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-red-300">{error}</p>
      ) : null}
      {resumeMsg ? (
        <p className="mt-3 text-sm text-teal-200/90">{resumeMsg}</p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Dot ok={Boolean(an?.ok)} />
            <p className="text-[10px] uppercase tracking-wider text-white/40">
              Anthropic · Claude
            </p>
          </div>
          {!usage ? (
            <p className="mt-2 text-sm text-white/35">Probing…</p>
          ) : (
            <>
              <p className="mt-1.5 text-sm font-medium text-white">
                {an?.ok
                  ? "Available"
                  : an?.limitKind === "usage_cap"
                    ? "Usage cap hit"
                    : an?.configured
                      ? "Blocked"
                      : "Not configured"}
              </p>
              <p className="mt-0.5 text-[11px] text-white/40">
                Active path: {an?.transport ?? "—"}
                {an?.regainAt ? ` · unlocks ${an.regainAt}` : ""}
              </p>
              {an?.transportReason ? (
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/35">
                  {an.transportReason}
                </p>
              ) : null}
              {an?.error && !an.ok ? (
                <p className="mt-2 line-clamp-2 text-[11px] leading-snug text-red-200/80">
                  {an.error}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-3">
          <div className="flex items-center gap-2">
            <Dot ok={Boolean(or?.ok)} warn={orNearCap} />
            <p className="text-[10px] uppercase tracking-wider text-white/40">
              OpenRouter · embeds + fallback
            </p>
          </div>
          {!usage ? (
            <p className="mt-2 text-sm text-white/35">Probing…</p>
          ) : (
            <>
              <p className="mt-1.5 text-sm font-medium text-white">
                {or?.ok
                  ? or.unlimited
                    ? "No key cap"
                    : `${fmtUsd(or.limitRemainingUsd)} left`
                  : or?.configured
                    ? "Error"
                    : "Not configured"}
              </p>
              <p className="mt-0.5 text-[11px] text-white/40">
                {or?.ok
                  ? `Month ${fmtUsd(or.usageMonthly)} · all-time ${fmtUsd(or.usageAllTime)}`
                  : or?.error || "—"}
                {or?.limitUsd != null ? ` · cap ${fmtUsd(or.limitUsd)}` : ""}
              </p>
            </>
          )}
        </div>
      </div>

      {usingFallback ? (
        <p className="mt-3 text-[11px] leading-relaxed text-white/45">
          Auto-fallback is on. Raise the Anthropic Console spend limit when you
          can — distill will switch back to direct on the next probe.
        </p>
      ) : anthropicBlocked && !or?.ok ? (
        <p className="mt-3 text-[11px] leading-relaxed text-white/45">
          Anthropic is capped and OpenRouter is unavailable. Fix one of the
          keys, then Resume.
        </p>
      ) : null}
    </div>
  );
}
