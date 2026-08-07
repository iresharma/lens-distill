import type { Job, NewJob } from "@/db/schema";
import type { WorkerDb } from "@/db";

export type StageHandler = (
  job: Job,
  wdb: WorkerDb,
  deadline: number,
) => Promise<NewJob | null>;

export type JobPayload = {
  cursor?: number;
  chapterOnly?: number;
};
