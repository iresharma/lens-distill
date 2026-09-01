import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { claims } from "@/db/schema";
import { withSpan } from "@/lib/otel/tracer";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await ctx.params;
  const url = new URL(req.url);
  const focus = url.searchParams.get("focus");

  // Focus path: neighbors only. Never combine with the full points payload —
  // older clients requested both and sat on the connection for minutes.
  if (focus) {
    return withSpan(
      "db.query.embeddings_focus",
      { "book.id": bookId, focus: true },
      async (span) => {
        const rows = await db.execute(sql`
          SELECT
            c.claim_id AS "claimId",
            c.statement,
            c.superseded,
            (1 - (c.embedding <=> f.embedding))::float8 AS score
          FROM claims c
          CROSS JOIN (
            SELECT embedding
            FROM claims
            WHERE book_id = ${bookId} AND claim_id = ${focus}
            LIMIT 1
          ) f
          WHERE c.book_id = ${bookId}
            AND c.claim_id <> ${focus}
            AND c.embedding IS NOT NULL
            AND f.embedding IS NOT NULL
          ORDER BY c.embedding <=> f.embedding
          LIMIT 6
        `);

        const neighbors = (
          rows.rows as {
            claimId: string;
            statement: string;
            score: number;
            superseded: string | null;
          }[]
        ).map((r) => ({
          claimId: r.claimId,
          statement: r.statement,
          score: Number(r.score),
          superseded: r.superseded,
        }));

        span.setAttribute("db.row_count", neighbors.length);
        return Response.json({ points: [], neighbors, focus });
      },
    );
  }

  return withSpan(
    "db.query.embeddings_points",
    { "book.id": bookId, focus: false },
    async (span) => {
      const points = await db
        .select({
          claimId: claims.claimId,
          statement: claims.statement,
          clusterId: claims.clusterId,
          projX: claims.projX,
          projY: claims.projY,
          superseded: claims.superseded,
        })
        .from(claims)
        .where(and(eq(claims.bookId, bookId), sql`${claims.projX} IS NOT NULL`));

      span.setAttribute("db.row_count", points.length);
      return Response.json({
        points,
        neighbors: [],
        focus: null,
      });
    },
  );
}
