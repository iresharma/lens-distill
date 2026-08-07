"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UploadForm({
  defaultPersona,
  slotsRemaining,
}: {
  defaultPersona: string;
  slotsRemaining: number;
}) {
  const router = useRouter();
  const [persona, setPersona] = useState(defaultPersona);
  const [fileName, setFileName] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (slotsRemaining <= 0) {
      setError("No slots left this week (global 3-book cap).");
      return;
    }
    const form = e.currentTarget;
    const fd = new FormData(form);
    fd.set("persona", persona);
    fd.set("acknowledgeCost", ack ? "true" : "false");
    setBusy(true);
    try {
      const res = await fetch("/api/books", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload failed");
        setBusy(false);
        return;
      }
      router.push(`/books/${data.bookId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className="text-[10px] uppercase tracking-wider text-white/40">
          PDF
        </label>
        <label className="mt-1.5 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/20 px-4 py-7 transition hover:border-violet-400/40 hover:bg-violet-500/[0.04]">
          <input
            name="file"
            type="file"
            accept="application/pdf,.pdf"
            required
            className="sr-only"
            onChange={(e) =>
              setFileName(e.target.files?.[0]?.name ?? null)
            }
          />
          <span className="text-sm text-white/80">
            {fileName ?? "Drop or choose a PDF"}
          </span>
          <span className="mt-1 text-[11px] text-white/35">
            Max 25 MB · chapters 5–40 · ≤550 chunks
          </span>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">
            Title
          </label>
          <input
            name="title"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25"
            placeholder="From PDF metadata if blank"
          />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">
            Authors
          </label>
          <input
            name="authors"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25"
            placeholder="Comma-separated"
          />
        </div>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label className="text-[10px] uppercase tracking-wider text-white/40">
            extract.md persona
          </label>
          <span className="font-mono text-[10px] text-white/30">
            {persona.length}/4000
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-white/40">
          Topic lens for claims — cannot change models, bypass the weekly cap,
          or override safety rules.
        </p>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          rows={8}
          maxLength={4000}
          className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-white/85"
        />
      </div>

      <label className="flex items-start gap-3 text-sm leading-snug text-white/55">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="mt-0.5 accent-violet-400"
        />
        <span>
          I understand each run spends real LLM money, and the site takes at
          most <span className="text-white/80">3 books / week globally</span>.
        </span>
      </label>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}

      <button
        type="submit"
        disabled={busy || !ack || slotsRemaining <= 0}
        className="w-full rounded-full bg-white px-5 py-3 text-sm font-semibold text-[#0a0a0b] transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-35"
      >
        {busy
          ? "Uploading & starting pipeline…"
          : slotsRemaining <= 0
            ? "Weekly slots exhausted"
            : "Start distill →"}
      </button>
    </form>
  );
}
