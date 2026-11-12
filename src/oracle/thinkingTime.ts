import type { ThinkingTimeLevel } from "./types.js";

/** Canonical effort levels in ChatGPT slider order; the array index is the slider value. */
export const THINKING_TIME_LEVELS = ["instant", "medium", "high", "extra-high", "pro"] as const;

/** Display labels ChatGPT shows for each slider step. */
export const THINKING_TIME_LABELS: Readonly<Record<ThinkingTimeLevel, string>> = {
  instant: "Instant",
  medium: "Medium",
  high: "High",
  "extra-high": "Extra High",
  pro: "Pro",
};

/**
 * Earlier four-level names and UI aliases. Their meaning is fixed:
 * light/low -> instant, standard -> medium, extended -> high, heavy/xhigh -> extra-high.
 */
export const THINKING_TIME_ALIASES = [
  "light",
  "low",
  "standard",
  "extended",
  "heavy",
  "extra high",
  "extrahigh",
  "xhigh",
] as const;
export const THINKING_TIME_INPUT_VALUES = [
  ...THINKING_TIME_LEVELS,
  ...THINKING_TIME_ALIASES,
] as const;

export type ThinkingTimeInput = (typeof THINKING_TIME_INPUT_VALUES)[number];

export function normalizeThinkingTimeLevel(
  value: string | null | undefined,
): ThinkingTimeLevel | null {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  switch (normalized) {
    case "instant":
    case "light":
    case "low":
      return "instant";
    case "medium":
    case "standard":
      return "medium";
    case "high":
    case "extended":
      return "high";
    case "extra-high":
    case "extrahigh":
    case "heavy":
    case "xhigh":
      return "extra-high";
    case "pro":
      return "pro";
    default:
      return null;
  }
}

/** Slider index (0..4) for a canonical effort level. */
export function thinkingTimeLevelIndex(level: ThinkingTimeLevel): number {
  return THINKING_TIME_LEVELS.indexOf(level);
}

/** Canonical effort level for a slider index, or null when the index is outside 0..4. */
export function thinkingTimeLevelAtIndex(index: number): ThinkingTimeLevel | null {
  return Number.isInteger(index) ? (THINKING_TIME_LEVELS[index] ?? null) : null;
}
