import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  real,
  bigserial,
  timestamp,
  jsonb,
  index,
  primaryKey,
  vector,
} from "drizzle-orm/pg-core";

export const PIPELINE_STAGES = [
  "chunk",
  "embed",
  "extract",
  "dedupe",
  "canonicalize",
  "concepts",
  "concept_graph",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const books = pgTable("books", {
  bookId: text("book_id").primaryKey(),
  title: text("title").notNull(),
  authors: text("authors").array().notNull(),
  sourceFormat: text("source_format", { enum: ["epub", "pdf"] })
    .notNull()
    .default("pdf"),
  structureConf: text("structure_conf", {
    enum: ["high", "medium", "low"],
  }).notNull(),
  pageOffset: integer("page_offset"),
  extractPrompt: text("extract_prompt").notNull(),
  status: text("status", {
    enum: ["queued", "running", "ready", "failed"],
  })
    .notNull()
    .default("queued"),
  statusError: text("status_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  readyAt: timestamp("ready_at", { withTimezone: true }),
});

export const paragraphs = pgTable(
  "paragraphs",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    paraIndex: integer("para_index").notNull(),
    chapterIndex: integer("chapter_index"),
    chapterTitle: text("chapter_title"),
    sectionTitle: text("section_title"),
    page: integer("page"),
    blockKind: text("block_kind", {
      enum: ["body", "heading", "list", "quote", "table"],
    }).notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.paraIndex] }),
    index("paragraphs_chapter_idx").on(t.bookId, t.chapterIndex),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    chunkId: text("chunk_id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    paraStart: integer("para_start").notNull(),
    paraEnd: integer("para_end").notNull(),
    chapterIndex: integer("chapter_index"),
    sectionTitle: text("section_title"),
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    tokenCount: integer("token_count").notNull(),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (t) => [
    index("chunks_book_idx").on(t.bookId, t.chunkIndex),
    index("chunks_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const claims = pgTable(
  "claims",
  {
    claimId: text("claim_id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    statement: text("statement").notNull(),
    claimType: text("claim_type", {
      enum: [
        "definition",
        "mechanic",
        "heuristic",
        "warning",
        "negotiation_move",
        "anecdote",
        "market_norm",
      ],
    }).notNull(),
    favors: text("favors", {
      enum: ["investor", "founder", "neutral", "not_applicable"],
    }),
    anchorQuote: text("anchor_quote"),
    supportParas: integer("support_paras").array().notNull(),
    concepts: text("concepts").array().notNull(),
    canonicalConcepts: text("canonical_concepts").array(),
    sourceChunks: text("source_chunks").array().notNull(),
    superseded: text("superseded"),
    clusterId: text("cluster_id"),
    projX: real("proj_x"),
    projY: real("proj_y"),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (t) => [
    index("claims_book_idx").on(t.bookId),
    index("claims_concepts_idx").using("gin", t.concepts),
    index("claims_cluster_idx").on(t.bookId, t.clusterId),
    index("claims_emb_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export type ConfusablePair = {
  concept_id: string;
  distinction: string;
};

export const concepts = pgTable("concepts", {
  conceptId: text("concept_id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.bookId, { onDelete: "cascade" }),
  label: text("label").notNull(),
  oneLiner: text("one_liner").notNull(),
  favors: text("favors", {
    enum: ["investor", "founder", "neutral", "not_applicable"],
  }),
  primaryChapter: integer("primary_chapter"),
  claimIds: text("claim_ids").array().notNull(),
  prerequisites: text("prerequisites")
    .array()
    .notNull()
    .default(sql`'{}'`),
  related: text("related")
    .array()
    .notNull()
    .default(sql`'{}'`),
  confusableWith: jsonb("confusable_with")
    .$type<ConfusablePair[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
});

export const conceptVocab = pgTable(
  "concept_vocab",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    rawTag: text("raw_tag").notNull(),
    canonicalTag: text("canonical_tag").notNull(),
    claimCount: integer("claim_count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.rawTag] }),
    index("concept_vocab_canon_idx").on(t.bookId, t.canonicalTag),
  ],
);

export const conceptEdges = pgTable(
  "concept_edges",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    src: text("src").notNull(),
    dst: text("dst").notNull(),
    edgeKind: text("edge_kind", {
      enum: ["prerequisite", "related", "confusable"],
    }).notNull(),
    distinction: text("distinction"),
    source: text("source", {
      enum: ["llm", "cooccurrence", "book_order"],
    }).notNull(),
    weight: real("weight").notNull().default(1.0),
  },
  (t) => [
    primaryKey({ columns: [t.bookId, t.src, t.dst, t.edgeKind] }),
  ],
);

export const stageRuns = pgTable(
  "stage_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.bookId, { onDelete: "cascade" }),
    stage: text("stage", {
      enum: [
        "chunk",
        "embed",
        "extract",
        "dedupe",
        "canonicalize",
        "concepts",
        "concept_graph",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
  },
  (t) => [
    index("stage_runs_book_idx").on(t.bookId, t.stage),
  ],
);

export const quotaEvents = pgTable("quota_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.bookId, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bookId: text("book_id").notNull(),
    stage: text("stage", {
      enum: [
        "chunk",
        "embed",
        "extract",
        "dedupe",
        "canonicalize",
        "concepts",
        "concept_graph",
      ],
    }).notNull(),
    payload: jsonb("payload")
      .$type<{ cursor?: number; chapterOnly?: number }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status", {
      enum: ["pending", "running", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("jobs_ready_idx")
      .on(t.runAfter, t.id)
      .where(sql`status = 'pending'`),
  ],
);

export type Book = typeof books.$inferSelect;
export type Paragraph = typeof paragraphs.$inferSelect;
export type Chunk = typeof chunks.$inferSelect;
export type Claim = typeof claims.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type ConceptVocab = typeof conceptVocab.$inferSelect;
export type ConceptEdge = typeof conceptEdges.$inferSelect;
export type StageRun = typeof stageRuns.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
