import type { Anthropic } from "@anthropic-ai/sdk";
import { otelLog } from "@/lib/otel/logger";

type Message = Anthropic.Messages.Message;

export function requireToolUse(res: Message, stageName: string) {
  if (res.stop_reason === "max_tokens") {
    otelLog.error("LLM response truncated at max_tokens", {
      scope: "llm",
      stageName,
      model: res.model,
    });
    throw new Error(
      `${stageName}: response truncated at max_tokens — reduce input or output schema`,
    );
  }
  const toolBlock = res.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    otelLog.error("LLM response missing tool_use block", {
      scope: "llm",
      stageName,
      model: res.model,
      stopReason: res.stop_reason,
    });
    throw new Error(
      `${stageName}: no tool_use block; stop_reason=${res.stop_reason}`,
    );
  }
  return toolBlock;
}
