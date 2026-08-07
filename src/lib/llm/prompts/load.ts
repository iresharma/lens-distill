import { readFileSync } from "fs";
import { join } from "path";

export function loadPrompt(name: string): string {
  return readFileSync(
    join(process.cwd(), "src/lib/llm/prompts", `${name}.md`),
    "utf8",
  );
}
