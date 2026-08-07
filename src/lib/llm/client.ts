import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export const MODELS = {
  extract: process.env.DISTILL_EXTRACT_MODEL || "claude-haiku-4-5-20251001",
  merge: process.env.DISTILL_MERGE_MODEL || "claude-sonnet-5",
  concepts: process.env.DISTILL_CONCEPTS_MODEL || "claude-opus-5",
  embed: process.env.DISTILL_EMBED_MODEL || "openai/text-embedding-3-small",
} as const;

let _anthropic: Anthropic | null = null;
let _openrouter: OpenAI | null = null;

export function anthropic(): Anthropic {
  if (!_anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    _anthropic = new Anthropic({ apiKey: key });
  }
  return _anthropic;
}

export function openrouter(): OpenAI {
  if (!_openrouter) {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    _openrouter = new OpenAI({
      apiKey: key,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL || "https://lens.iresharma.com",
        "X-Title": process.env.OPENROUTER_APP_NAME || "Lens Distill",
      },
    });
  }
  return _openrouter;
}

export type EmbedResult = {
  vectors: number[][];
  /** Embedding APIs bill input/prompt tokens only — no output tokens. */
  inputTokens: number;
};

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], inputTokens: 0 };
  const client = openrouter();
  const res = await client.embeddings.create({
    model: MODELS.embed,
    input: texts,
  });
  const vectors = res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
  const inputTokens =
    res.usage?.prompt_tokens ??
    res.usage?.total_tokens ??
    texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
  return { vectors, inputTokens };
}
