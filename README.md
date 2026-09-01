# Lens Distill

Portfolio demo: upload a PDF and an `extract.md` persona, run a real book-distillation pipeline, and inspect claims, concepts, a concept graph, and claim-embedding clusters.

```
chunk → embed → extract → dedupe → canonicalize → concepts → concept_graph
```

Drain starts automatically after upload (`after()` + chained continue). No cron worker, no manual stage-advance UI. The PDF is parsed then discarded — only paragraphs and derived artifacts are stored.

## Cost / quota

- Runs call Anthropic (Haiku / Sonnet / Opus) and OpenRouter embeddings.
- **Global limit: 3 accepted books per rolling week** for the whole site.
- Upload requires an explicit cost acknowledgment.
- Guards: PDF ≤ 25 MB, chapters 5–40, ≤ ~550 chunks.

## Prompt injection

User personas are treated as an untrusted **topic lens**:

- Fixed outer system prompt (not user-editable)
- Persona fenced in `<persona>…</persona>`
- Soft deny-list for override phrases
- Forced `emit_claims` tool + citation range checks in code

## Setup

```bash
cp .env.example .env.local
# fill DATABASE_URL, ANTHROPIC_API_KEY, OPENROUTER_API_KEY

npm install
npm run db:migrate   # creates the vector extension, tables, and indexes
npm run dev           # http://localhost:3001
```

Any Postgres server works, as long as the `pgvector` extension is installable
(the migration runs `CREATE EXTENSION IF NOT EXISTS vector` itself). The
Docker image runs the same migrations automatically on container startup —
see `scripts/migrate.mjs` / `scripts/docker-entrypoint.sh` — so a fresh
database gets its schema created on first boot with no manual step.

If a drain chain dies mid-book:

```bash
npm run resume
```

## UI

| Surface | What it shows |
|---|---|
| Home | Gallery, stats, upload |
| Timeline | Per-stage metrics from `stage_runs` |
| Concepts / Claims | Nodes + expandable real citations |
| Graph | Force-directed concept graph |
| Embeddings | 2D PCA scatter; click → top-6 cosine neighbors (HNSW) |

## Stack

Next.js · Drizzle · Postgres + pgvector · Anthropic · OpenRouter · pdfjs · D3
