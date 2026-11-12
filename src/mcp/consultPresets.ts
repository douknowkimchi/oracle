import type { ThinkingTimeLevel } from "../oracle/types.js";
import type { ConsultInput } from "./types.js";

const CHATGPT_PRO_HEAVY_MODEL = "gpt-5.5-pro";
// Legacy "extended" keeps its fixed meaning: slider step 2 (High).
const CHATGPT_PRO_HEAVY_THINKING_TIME: ThinkingTimeLevel = "high";

export function applyConsultPreset(input: ConsultInput): ConsultInput {
  if (!input.preset) {
    return input;
  }
  if (input.preset === "chatgpt-pro-heavy") {
    if (input.models && input.models.length > 0) {
      throw new Error('MCP consult preset "chatgpt-pro-heavy" cannot be combined with models.');
    }
    return {
      ...input,
      engine: input.engine ?? "browser",
      model: input.model ?? CHATGPT_PRO_HEAVY_MODEL,
      browserThinkingTime: input.browserThinkingTime ?? CHATGPT_PRO_HEAVY_THINKING_TIME,
    };
  }
  return input;
}
