import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "../types.js";
import type { BrowserPreSubmitVerification, BrowserRunWarning } from "../../sessionStore.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { THINKING_TIME_LABELS, thinkingTimeLevelAtIndex } from "../../oracle/thinkingTime.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { DEFAULT_MODEL_STRATEGY } from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { isModelSubmenuLabel, readModelSubmenuSelection } from "./modelSelection.js";
import { describeEffortSliderProblem, readEffortSlider } from "./thinkingTime.js";
import { readDeepResearchComposerToken } from "./deepResearch.js";
import { clearPromptComposer, type BeforeSendDecision } from "./promptComposer.js";
import { clearComposerAttachments } from "./attachments.js";

/** What the final check must prove right before send. */
export interface PreSubmitPlan {
  requestedModel: string | null;
  /** Exact model submenu label to verify, or null when the model is not verifiable there. */
  modelLabel: string | null;
  requestedEffort: ThinkingTimeLevel | null;
  deepResearch: boolean;
  stopBeforeSubmit: boolean;
}

/**
 * Returns the final-check plan, or null when nothing explicit was requested and the run is not
 * a stop-before-submit check (plain runs keep their previous behavior).
 */
export function resolvePreSubmitPlan(
  config: Pick<
    ResolvedBrowserConfig,
    "desiredModel" | "modelStrategy" | "thinkingTime" | "researchMode" | "stopBeforeSubmit"
  >,
  options: { requestedModel?: string | null; resumingConversation: boolean },
): PreSubmitPlan | null {
  const strategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  const modelLabel =
    strategy === "select" &&
    !options.resumingConversation &&
    isModelSubmenuLabel(config.desiredModel)
      ? (config.desiredModel ?? null)
      : null;
  const requestedEffort = config.thinkingTime ?? null;
  const deepResearch = config.researchMode === "deep";
  const stopBeforeSubmit = config.stopBeforeSubmit === true;
  if (!modelLabel && !requestedEffort && !deepResearch && !stopBeforeSubmit) {
    return null;
  }
  return {
    requestedModel: options.requestedModel ?? config.desiredModel ?? null,
    modelLabel,
    requestedEffort,
    deepResearch,
    stopBeforeSubmit,
  };
}

/**
 * Reads model, effort and Deep Research state from the composer that holds the prepared prompt.
 * Returns the evidence when everything requested matches; otherwise throws a
 * BrowserAutomationError carrying the same evidence in `details.preSubmitVerification`.
 */
export async function verifyComposerBeforeSubmit(
  Runtime: ChromeClient["Runtime"],
  plan: PreSubmitPlan,
  submission: { attachmentCount: number; prompt: string },
  logger: BrowserLogger,
): Promise<BrowserPreSubmitVerification> {
  const mismatches: string[] = [];
  const diagnostics: Record<string, unknown> = {};

  let resolvedModelLabel: string | null = null;
  let modelChecked = false;
  if (plan.modelLabel) {
    const model = await readModelSubmenuSelection(Runtime, plan.modelLabel);
    if (!model.ok) {
      mismatches.push(`model: could not read the model submenu (${model.failure.reason})`);
      diagnostics.model = model.failure;
    } else {
      resolvedModelLabel = model.checkedLabels.length === 1 ? model.checkedLabels[0] : null;
      modelChecked = model.targetChecked;
      if (!modelChecked) {
        mismatches.push(
          `model: expected "${plan.modelLabel}" checked, observed [${model.checkedLabels.join(", ")}]`,
        );
      }
    }
  }

  let observedEffortIndex: number | null = null;
  let effortRangeMin: number | null = null;
  let effortRangeMax: number | null = null;
  if (plan.requestedEffort) {
    const effort = await readEffortSlider(Runtime);
    if (!effort.ok) {
      mismatches.push(`effort: could not read the slider (${effort.failure.reason})`);
      diagnostics.effort = effort.failure;
    } else {
      observedEffortIndex = effort.state.value;
      effortRangeMin = effort.state.min;
      effortRangeMax = effort.state.max;
      const problem = describeEffortSliderProblem(effort.state);
      const expected = thinkingTimeLevelAtIndex(observedEffortIndex ?? -1);
      if (problem) {
        mismatches.push(`effort: ${problem}`);
        diagnostics.effort = effort.state;
      } else if (expected !== plan.requestedEffort) {
        mismatches.push(
          `effort: expected ${plan.requestedEffort} (${THINKING_TIME_LABELS[plan.requestedEffort]}), observed index ${observedEffortIndex}`,
        );
      }
    }
  }

  // Read last: the token must survive prompt, attachments and the picker reads above.
  const token = await readDeepResearchComposerToken(Runtime, { prompt: submission.prompt });
  if (!token.composerFound) {
    mismatches.push("composer: no single visible composer form holds the prompt");
  }
  if (plan.deepResearch && !token.present) {
    mismatches.push("deep research: connector token is missing from the composer");
    diagnostics.deepResearch = token;
  }

  const observedLevel =
    observedEffortIndex === null ? null : thinkingTimeLevelAtIndex(observedEffortIndex);
  const evidence: BrowserPreSubmitVerification = {
    requestedModel: plan.requestedModel,
    resolvedModelLabel,
    modelChecked,
    requestedEffort: plan.requestedEffort,
    observedEffortIndex,
    observedEffortLabel: observedLevel ? THINKING_TIME_LABELS[observedLevel] : null,
    effortRangeMin,
    effortRangeMax,
    deepResearchRequested: plan.deepResearch,
    deepResearchTokenPresent: token.present,
    attachmentCount: submission.attachmentCount,
    verified: mismatches.length === 0,
    stoppedBeforeSubmit: plan.stopBeforeSubmit,
    mismatches,
    capturedAt: new Date().toISOString(),
  };
  if (evidence.verified) {
    logger(
      `[browser] Pre-submit verification passed: ${JSON.stringify({
        model: resolvedModelLabel,
        effort: evidence.observedEffortLabel,
        deepResearchToken: token.present,
        attachments: submission.attachmentCount,
      })}`,
    );
    return evidence;
  }
  await logDomFailure(Runtime, logger, "pre-submit-verification");
  logger(
    `[browser] Pre-submit verification failed: ${JSON.stringify({ mismatches, diagnostics })}`,
  );
  throw new BrowserAutomationError(
    `Pre-submit verification failed; nothing was sent. ${mismatches.join("; ")}`,
    {
      stage: "pre-submit-verification",
      code: "pre-submit-mismatch",
      preSubmitVerification: evidence,
    },
  );
}

/** Builds the submitPrompt hook that runs the final check and stops when requested. */
export function createPreSubmitGate(
  Runtime: ChromeClient["Runtime"],
  plan: PreSubmitPlan,
  logger: BrowserLogger,
): {
  beforeSend: (submission: {
    attachmentCount: number;
    prompt: string;
  }) => () => Promise<BeforeSendDecision>;
  readonly evidence: BrowserPreSubmitVerification | undefined;
  readonly stopped: boolean;
} {
  let evidence: BrowserPreSubmitVerification | undefined;
  let stopped = false;
  return {
    beforeSend: (submission) => async () => {
      evidence = await verifyComposerBeforeSubmit(Runtime, plan, submission, logger);
      if (plan.stopBeforeSubmit) {
        stopped = true;
        return "stop";
      }
      return "send";
    },
    get evidence() {
      return evidence;
    },
    get stopped() {
      return stopped;
    },
  };
}

/**
 * Empties the composer after a stop-before-submit check so the profile keeps no draft.
 * Cleanup problems become warnings; they never change the verification result or send.
 */
export async function clearComposerAfterStop(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  submission: { attachmentCount: number; prompt: string },
): Promise<BrowserRunWarning[]> {
  const warnings: BrowserRunWarning[] = [];
  const attempt = async (code: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push({ code, severity: "warning", message });
      logger(`[browser] Stop-before-submit cleanup warning (${code}): ${message}`);
    }
  };
  await attempt("stop-cleanup-prompt", () => clearPromptComposer(Runtime, logger));
  if (submission.attachmentCount > 0) {
    await attempt("stop-cleanup-attachments", () =>
      clearComposerAttachments(Runtime, 5_000, logger),
    );
  }
  await attempt("stop-cleanup-deep-research", async () => {
    const token = await readDeepResearchComposerToken(Runtime, { prompt: "" });
    if (token.present) {
      throw new Error(
        `Deep Research connector token is still in the composer (${token.locations.join(", ")}).`,
      );
    }
  });
  return warnings;
}
