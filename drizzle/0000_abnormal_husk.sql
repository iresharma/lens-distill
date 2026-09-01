CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "books" (
	"book_id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"authors" text[] NOT NULL,
	"source_format" text DEFAULT 'pdf' NOT NULL,
	"structure_conf" text NOT NULL,
	"page_offset" integer,
	"extract_prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"status_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"chunk_id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"para_start" integer NOT NULL,
	"para_end" integer NOT NULL,
	"chapter_index" integer,
	"section_title" text,
	"page_start" integer,
	"page_end" integer,
	"token_count" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"statement" text NOT NULL,
	"claim_type" text NOT NULL,
	"favors" text,
	"anchor_quote" text,
	"support_paras" integer[] NOT NULL,
	"concepts" text[] NOT NULL,
	"canonical_concepts" text[],
	"source_chunks" text[] NOT NULL,
	"superseded" text,
	"cluster_id" text,
	"proj_x" real,
	"proj_y" real,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE "concept_edges" (
	"book_id" text NOT NULL,
	"src" text NOT NULL,
	"dst" text NOT NULL,
	"edge_kind" text NOT NULL,
	"distinction" text,
	"source" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	CONSTRAINT "concept_edges_book_id_src_dst_edge_kind_pk" PRIMARY KEY("book_id","src","dst","edge_kind")
);
--> statement-breakpoint
CREATE TABLE "concept_vocab" (
	"book_id" text NOT NULL,
	"raw_tag" text NOT NULL,
	"canonical_tag" text NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "concept_vocab_book_id_raw_tag_pk" PRIMARY KEY("book_id","raw_tag")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"concept_id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"label" text NOT NULL,
	"one_liner" text NOT NULL,
	"favors" text,
	"primary_chapter" integer,
	"claim_ids" text[] NOT NULL,
	"prerequisites" text[] DEFAULT '{}' NOT NULL,
	"related" text[] DEFAULT '{}' NOT NULL,
	"confusable_with" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"stage" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paragraphs" (
	"book_id" text NOT NULL,
	"para_index" integer NOT NULL,
	"chapter_index" integer,
	"chapter_title" text,
	"section_title" text,
	"page" integer,
	"block_kind" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "paragraphs_book_id_para_index_pk" PRIMARY KEY("book_id","para_index")
);
--> statement-breakpoint
CREATE TABLE "quota_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_edges" ADD CONSTRAINT "concept_edges_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_vocab" ADD CONSTRAINT "concept_vocab_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paragraphs" ADD CONSTRAINT "paragraphs_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_events" ADD CONSTRAINT "quota_events_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_runs" ADD CONSTRAINT "stage_runs_book_id_books_book_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("book_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_book_idx" ON "chunks" USING btree ("book_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_emb_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "claims_book_idx" ON "claims" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "claims_concepts_idx" ON "claims" USING gin ("concepts");--> statement-breakpoint
CREATE INDEX "claims_cluster_idx" ON "claims" USING btree ("book_id","cluster_id");--> statement-breakpoint
CREATE INDEX "claims_emb_idx" ON "claims" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "concept_vocab_canon_idx" ON "concept_vocab" USING btree ("book_id","canonical_tag");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("run_after","id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "paragraphs_chapter_idx" ON "paragraphs" USING btree ("book_id","chapter_index");--> statement-breakpoint
CREATE INDEX "stage_runs_book_idx" ON "stage_runs" USING btree ("book_id","stage");