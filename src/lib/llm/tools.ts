import type { Anthropic } from "@anthropic-ai/sdk";

type Tool = Anthropic.Messages.Tool;

export const emitClaims: Tool = {
  name: "emit_claims",
  description: "Emit practitioner-relevant claims extracted from the chunk.",
  input_schema: {
    type: "object",
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          required: ["statement", "type", "concepts", "support_paras"],
          properties: {
            statement: {
              type: "string",
              maxLength: 300,
              description:
                "One self-contained assertion, paraphrased in neutral language. Must stand alone without surrounding context. No pronouns referring outside the claim.",
            },
            type: {
              type: "string",
              enum: [
                "definition",
                "mechanic",
                "heuristic",
                "warning",
                "negotiation_move",
                "anecdote",
                "market_norm",
              ],
            },
            concepts: {
              type: "array",
              items: { type: "string" },
              description:
                "snake_case canonical terms, e.g. liquidation_preference, option_pool_shuffle",
            },
            support_paras: {
              type: "array",
              items: { type: "integer" },
              description:
                "para_index values from the [pNNN] markers that directly support this claim",
            },
            favors: {
              type: "string",
              enum: ["investor", "founder", "neutral", "not_applicable"],
            },
            anchor_quote: {
              type: "string",
              maxLength: 90,
              description:
                "OPTIONAL. Verbatim, under 15 words. Only where exact wording carries legal or definitional weight. Omit by default.",
            },
          },
        },
      },
    },
  },
};

export const emitMerge: Tool = {
  name: "emit_merge",
  description: "Merge near-duplicate claims into one canonical claim.",
  input_schema: {
    type: "object",
    required: ["statement", "type", "favors", "concepts"],
    properties: {
      statement: { type: "string", maxLength: 300 },
      type: {
        type: "string",
        enum: [
          "definition",
          "mechanic",
          "heuristic",
          "warning",
          "negotiation_move",
          "anecdote",
          "market_norm",
        ],
      },
      favors: {
        type: "string",
        enum: ["investor", "founder", "neutral", "not_applicable"],
      },
      concepts: { type: "array", items: { type: "string" } },
    },
  },
};

export const emitConceptGraph: Tool = {
  name: "emit_concept_graph",
  description:
    "Emit prerequisite / related / confusable edges over an existing concept inventory. Do not emit claim_ids.",
  input_schema: {
    type: "object",
    required: ["edges"],
    properties: {
      edges: {
        type: "array",
        items: {
          type: "object",
          required: ["concept_id"],
          properties: {
            concept_id: { type: "string" },
            prerequisites: {
              type: "array",
              items: { type: "string" },
              maxItems: 3,
            },
            related: {
              type: "array",
              items: { type: "string" },
              maxItems: 5,
            },
            confusable_with: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                required: ["concept_id", "distinction"],
                properties: {
                  concept_id: { type: "string" },
                  distinction: { type: "string", maxLength: 200 },
                },
              },
            },
          },
        },
      },
    },
  },
};
