import { and, arrayContains, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { claims, paragraphs } from "@/db/schema";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await ctx.params;
  const url = new URL(req.url);
  const concept = url.searchParams.get("concept");
  const claimId = url.searchParams.get("claimId");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
  const offset = Number(url.searchParams.get("offset") || 0);

  if (claimId) {
    const [claim] = await db
      .select()
      .from(claims)
      .where(and(eq(claims.bookId, bookId), eq(claims.claimId, claimId)))
      .limit(1);
    if (!claim) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const paras =
      claim.supportParas.length === 0
        ? []
        : await db
            .select()
            .from(paragraphs)
            .where(
              and(
                eq(paragraphs.bookId, bookId),
                sql`${paragraphs.paraIndex} = ANY(${sql.raw(`ARRAY[${claim.supportParas.join(",")}]::int[]`)})`,
              ),
            );
    return Response.json({
      claim: {
        claimId: claim.claimId,
        statement: claim.statement,
        claimType: claim.claimType,
        favors: claim.favors,
        concepts: claim.canonicalConcepts ?? claim.concepts,
        supportParas: claim.supportParas,
        superseded: claim.superseded,
        clusterId: claim.clusterId,
      },
      paragraphs: paras.map((p) => ({
        paraIndex: p.paraIndex,
        chapterIndex: p.chapterIndex,
        chapterTitle: p.chapterTitle,
        sectionTitle: p.sectionTitle,
        text: p.text,
      })),
    });
  }

  const base = and(eq(claims.bookId, bookId), isNull(claims.superseded));

  let rows;
  if (concept) {
    const slug = concept.includes(":") ? concept.split(":").pop()! : concept;
    rows = await db
      .select()
      .from(claims)
      .where(
        and(
          base,
          or(
            arrayContains(claims.canonicalConcepts, [slug]),
            arrayContains(claims.concepts, [slug]),
            arrayContains(claims.canonicalConcepts, [concept]),
          ),
        ),
      )
      .limit(limit)
      .offset(offset);
  } else {
    rows = await db
      .select()
      .from(claims)
      .where(base)
      .limit(limit)
      .offset(offset);
  }

  return Response.json({
    claims: rows.map((c) => ({
      claimId: c.claimId,
      statement: c.statement,
      claimType: c.claimType,
      favors: c.favors,
      concepts: c.canonicalConcepts ?? c.concepts,
      supportParas: c.supportParas,
      clusterId: c.clusterId,
    })),
  });
}
