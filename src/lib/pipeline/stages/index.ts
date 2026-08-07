import type { StageHandler } from "../types";
import { chunkStage } from "./chunk";
import { embedStage } from "./embed";
import { extractStage } from "./extract";
import { dedupeStage } from "./dedupe";
import { canonicalizeStage } from "./canonicalize";
import { conceptsStage } from "./concepts";
import { conceptGraphStage } from "./concept-graph";

export const STAGES: Record<
  | "chunk"
  | "embed"
  | "extract"
  | "dedupe"
  | "canonicalize"
  | "concepts"
  | "concept_graph",
  StageHandler
> = {
  chunk: chunkStage,
  embed: embedStage,
  extract: extractStage,
  dedupe: dedupeStage,
  canonicalize: canonicalizeStage,
  concepts: conceptsStage,
  concept_graph: conceptGraphStage,
};
