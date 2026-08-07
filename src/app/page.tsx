import Link from "next/link";
import { desc, eq, isNull, sql } from "drizzle-orm";
import {
  BookGlyph,
  BrandMark,
  ClaimGlyph,
  ConceptGlyph,
  EdgeGlyph,
} from "@/components/BrandMark";
import { PipelineStrip } from "@/components/PipelineStrip";
import { UploadForm } from "@/components/UploadForm";
import { db } from "@/db";
import { books, claims, concepts, conceptEdges } from "@/db/schema";
import { DEFAULT_PERSONA } from "@/lib/persona/validate";
import { getSlotsRemaining } from "@/lib/quota";

export const dynamic = "force-dynamic";

function statusTone(status: string) {
  if (status === "ready")
    return "bg-emerald-500/15 text-emerald-300 ring-emerald-500/25";
  if (status === "running" || status === "queued")
    return "bg-violet-500/15 text-violet-300 ring-violet-500/30";
  if (status === "failed")
    return "bg-red-500/15 text-red-300 ring-red-500/25";
  return "bg-white/5 text-white/45 ring-white/10";
}

export default async function HomePage() {
  const slots = await getSlotsRemaining();
  const bookRows = await db.select().from(books).orderBy(desc(books.createdAt));
  const [{ claimCount }] = await db
    .select({ claimCount: sql<number>`count(*)::int` })
    .from(claims)
    .where(isNull(claims.superseded));
  const [{ conceptCount }] = await db
    .select({ conceptCount: sql<number>`count(*)::int` })
    .from(concepts);
  const [{ edgeCount }] = await db
    .select({ edgeCount: sql<number>`count(*)::int` })
    .from(conceptEdges);

  const gallery = await Promise.all(
    bookRows.map(async (b) => {
      const [{ live }] = await db
        .select({ live: sql<number>`count(*)::int` })
        .from(claims)
        .where(
          sql`${claims.bookId} = ${b.bookId} AND ${claims.superseded} IS NULL`,
        );
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(concepts)
        .where(eq(concepts.bookId, b.bookId));
      return {
        bookId: b.bookId,
        title: b.title,
        authors: b.authors,
        status: b.status,
        claimCount: live,
        conceptCount: n,
      };
    }),
  );

  const liveBooks = gallery.filter(
    (b) => b.status === "running" || b.status === "queued",
  ).length;

  const metrics = [
    {
      label: "Books",
      value: gallery.length,
      caption: liveBooks ? `${liveBooks} live` : "in gallery",
      tone: "text-violet-300",
      Icon: BookGlyph,
    },
    {
      label: "Live claims",
      value: claimCount,
      caption: "after dedupe",
      tone: "text-teal-300",
      Icon: ClaimGlyph,
    },
    {
      label: "Concepts",
      value: conceptCount,
      caption: `${edgeCount.toLocaleString()} edges`,
      tone: "text-amber-300",
      Icon: ConceptGlyph,
    },
    {
      label: "Slots left",
      value: slots.remaining,
      caption: `of ${slots.limit} this week`,
      tone: "text-rose-300",
      Icon: EdgeGlyph,
    },
  ];

  return (
    <div className="space-y-14">
      <section className="relative">
        <BrandMark size={36} />

        <h1 className="mt-5 max-w-xl text-4xl font-semibold tracking-tight text-white sm:text-5xl sm:leading-[1.08]">
          A book in.
          <br />
          <span className="bg-gradient-to-r from-violet-300 via-fuchsia-200 to-teal-300 bg-clip-text text-transparent">
            Cited claims out.
          </span>
        </h1>
        <p className="mt-5 max-w-lg text-base leading-relaxed text-white/55">
          Drop a PDF and an{" "}
          <code className="rounded bg-teal-500/10 px-1.5 py-0.5 font-mono text-[13px] text-teal-200">
            extract.md
          </code>{" "}
          persona. Linear jobs extract, dedupe, build concepts, then wire a
          graph — with a live timeline and embedding explorer.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <a
            href="#upload"
            className="inline-flex rounded-full bg-gradient-to-r from-violet-400 to-teal-400 px-5 py-2.5 text-sm font-semibold text-[#0a0a0b] transition hover:brightness-110"
          >
            Distill a book →
          </a>
          <a
            href="#gallery"
            className="inline-flex rounded-full border border-white/15 px-5 py-2.5 text-sm text-white/70 transition hover:border-teal-400/40 hover:text-teal-100"
          >
            See gallery
          </a>
          <span className="text-xs text-white/35">
            {slots.remaining} of {slots.limit} weekly slots · global cap
          </span>
        </div>

        <div className="mt-12">
          <PipelineStrip />
        </div>
      </section>

      {/* Stats — single row, no card grid clutter */}
      <section className="border-y border-white/[0.07] py-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="min-w-0">
              <div className="flex items-center gap-2">
                <m.Icon className={`h-3.5 w-3.5 ${m.tone}`} />
                <p className="text-[10px] uppercase tracking-wider text-white/40">
                  {m.label}
                </p>
              </div>
              <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight text-white">
                {m.value.toLocaleString()}
              </p>
              <p className="mt-0.5 text-xs text-white/35">{m.caption}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-10 lg:grid-cols-[1fr_0.95fr] lg:items-start">
        <section id="gallery" className="scroll-mt-8">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
                <BookGlyph className="h-3.5 w-3.5 text-violet-300" />
                Gallery
              </h2>
              <p className="mt-1 text-sm text-white/50">
                {liveBooks
                  ? `${liveBooks} running now`
                  : "Finished and in-flight books"}
              </p>
            </div>
          </div>

          <ul className="mt-5 space-y-3">
            {gallery.length === 0 ? (
              <li className="rounded-2xl border border-dashed border-white/12 px-5 py-12 text-center">
                <BrandMark size={40} className="mx-auto opacity-80" />
                <p className="mt-3 text-sm text-white/50">No books yet.</p>
                <a
                  href="#upload"
                  className="mt-2 inline-block text-sm text-teal-300 hover:underline"
                >
                  Take a slot →
                </a>
              </li>
            ) : (
              gallery.map((b, i) => (
                <li key={b.bookId}>
                  <Link
                    href={`/books/${b.bookId}`}
                    className="group relative block overflow-hidden rounded-2xl border border-white/10 bg-[#12141a]/90 transition hover:border-teal-400/35"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-violet-400 to-teal-400 opacity-0 transition group-hover:opacity-100"
                      aria-hidden
                    />
                    <div className="flex items-start justify-between gap-4 px-5 py-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-teal-500/50">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <p className="truncate font-medium text-white group-hover:text-teal-50">
                            {b.title}
                          </p>
                        </div>
                        <p className="mt-1 truncate text-xs text-white/40">
                          {b.authors?.length ? b.authors.join(", ") : "—"}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-white/45">
                          <span>
                            <span className="text-violet-200/90">
                              {b.claimCount.toLocaleString()}
                            </span>{" "}
                            claims
                          </span>
                          <span className="text-white/15">·</span>
                          <span>
                            <span className="text-teal-200/90">
                              {b.conceptCount}
                            </span>{" "}
                            concepts
                          </span>
                        </div>
                      </div>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wider ring-1 ${statusTone(b.status)}`}
                      >
                        {(b.status === "running" || b.status === "queued") && (
                          <span className="pipeline-dot-live h-1.5 w-1.5 rounded-full bg-current" />
                        )}
                        {b.status}
                      </span>
                    </div>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </section>

        <section
          id="upload"
          className="scroll-mt-8 rounded-2xl border border-white/10 bg-[#12141a]/90 p-5 sm:p-6 lg:sticky lg:top-6"
        >
          <h2 className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-teal-500/15 text-teal-300 ring-1 ring-teal-400/30">
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" aria-hidden>
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            Upload
          </h2>
          <p className="mt-1 text-sm text-white/50">
            Persona first, then PDF. Pipeline starts on success.
          </p>
          <div className="mt-5">
            <UploadForm
              defaultPersona={DEFAULT_PERSONA}
              slotsRemaining={slots.remaining}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
