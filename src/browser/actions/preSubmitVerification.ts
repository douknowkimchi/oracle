import type { BrowserLogger, ChromeClient, ResolvedBrowserConfig } from "../types.js";
import type { BrowserPreSubmitVerification, BrowserRunWarning } from "../../sessionStore.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { THINKING_TIME_LABELS, thinkingTimeLevelAtIndex } from "../../oracle/thinkingTime.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { DEFAULT_MODEL_STRATEGY } from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { isModelSubmenuLabel, readModelSubmenuSelection } from "./modelSelection.js";
import {
  describeEffortSliderProblem,
  readEffortSlider,
  type EffortSliderState,
} from "./thinkingTime.js";
import { readDeepResearchComposerToken } from "./deepResearch.js";
import { clearPromptComposer, type BeforeSendDecision } from "./promptComposer.js";
import { clearComposerAttachments } from "./attachments.js";

/** What the final check must prove right before send. */
export interface PreSubmitPlan {
  /** Requested model id, or null when the model is not part of the final check. */
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
  options: { requestedModel?: string | null },
): PreSubmitPlan | null {
  const strategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
  // Resumed conversations skip selection but are still read here, so a different checked
  // model fails before send. current/ignore never verify the model.
  const modelLabel =
    strategy === "select" && isModelSubmenuLabel(config.desiredModel)
      ? (config.desiredModel ?? null)
      : null;
  const requestedEffort = config.thinkingTime ?? null;
  const deepResearch = config.researchMode === "deep";
  const stopBeforeSubmit = config.stopBeforeSubmit === true;
  if (!modelLabel && !requestedEffort && !deepResearch && !stopBeforeSubmit) {
    return null;
  }
  return {
    // Only a model that the final check re-reads is reported as requested; verified=true must
    // never cover a model nobody looked at.
    requestedModel: modelLabel ? (options.requestedModel ?? config.desiredModel ?? null) : null,
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
  submission: { attachmentCount: number },
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

  // Read last: the chip must survive prompt, attachments and the picker reads above.
  const token = await readDeepResearchComposerToken(Runtime);
  if (!token.composerFound) {
    mismatches.push("composer: no single visible composer form holds the prompt");
  }
  if (plan.deepResearch) {
    logger(
      `[browser] Pre-submit Deep Research token diagnostic: ${JSON.stringify(token.occurrences)}`,
    );
    if (!token.present) {
      mismatches.push(
        "deep research: no connector chip with the Deep Research token in the composer",
      );
      diagnostics.deepResearch = token;
    }
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

/** Selection owners that run before send and can fail a run. */
export type PreSendSelectionStage =
  | "model-selection"
  | "thinking-time"
  | "deep-research-activation";

export interface PreSubmitGate {
  /** submitPrompt hook: runs the final check, then returns "stop" or "send". */
  beforeSend: (submission: { attachmentCount: number }) => () => Promise<BeforeSendDecision>;
  /**
   * Runs a selection owner (after its own retries). When it finally fails before any send
   * decision, the error is rethrown carrying `details.preSubmitVerification` with
   * verified=false. Transport failures and anything after a "send" decision pass through.
   */
  guardSelection: <T>(
    stage: PreSendSelectionStage,
    attachmentCount: number,
    action: () => Promise<T>,
  ) => Promise<T>;
  readonly evidence: BrowserPreSubmitVerification | undefined;
  readonly stopped: boolean;
}

export function createPreSubmitGate(
  Runtime: ChromeClient["Runtime"],
  plan: PreSubmitPlan,
  logger: BrowserLogger,
  options: {
    isTransportFailure?: (error: unknown) => boolean;
    /**
     * Receives passing evidence before beforeSend returns, so a caller can persist it no later
     * than the promptSubmitted hint that follows the send.
     */
    onVerified?: (evidence: BrowserPreSubmitVerification) => void;
  } = {},
): PreSubmitGate {
  let evidence: BrowserPreSubmitVerification | undefined;
  let stopped = false;
  let sendDecided = false;
  return {
    beforeSend: (submission) => {
      // Fixed per submission: a retry or follow-up after an earlier attempt reached the send
      // step must not claim that nothing was sent or replace the run's first evidence.
      if (sendDecided) {
        return async () => {
          await verifyLaterSubmission(Runtime, plan, submission, logger);
          return "send";
        };
      }
      return async () => {
        const firstEvidence = await verifyComposerBeforeSubmit(Runtime, plan, submission, logger);
        evidence = firstEvidence;
        options.onVerified?.(firstEvidence);
        if (plan.stopBeforeSubmit) {
          stopped = true;
          return "stop";
        }
        sendDecided = true;
        return "send";
      };
    },
    guardSelection: async (stage, attachmentCount, action) => {
      try {
        return await action();
      } catch (error) {
        if (
          sendDecided ||
          options.isTransportFailure?.(error) ||
          readPreSubmitEvidence(error) !== undefined
        ) {
          throw error;
        }
        const failure = buildSelectionFailureEvidence(plan, stage, error, attachmentCount);
        logger(
          `[browser] Pre-submit verification failed: ${JSON.stringify({ stage, mismatches: failure.mismatches })}`,
        );
        const details = error instanceof BrowserAutomationError ? error.details : undefined;
        throw new BrowserAutomationError(
          error instanceof Error ? error.message : String(error),
          {
            ...details,
            stage: (details as { stage?: string } | undefined)?.stage ?? stage,
            selectionStage: stage,
            preSubmitVerification: failure,
          },
          error,
        );
      }
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
 * Final check for a submission made after an earlier attempt in the same run reached the send
 * step (follow-up prompt or post-send retry). A mismatch still blocks this send, but the error
 * neither claims that nothing was sent nor carries session-level pre-submit evidence.
 */
async function verifyLaterSubmission(
  Runtime: ChromeClient["Runtime"],
  plan: PreSubmitPlan,
  submission: { attachmentCount: number },
  logger: BrowserLogger,
): Promise<void> {
  try {
    await verifyComposerBeforeSubmit(Runtime, plan, submission, logger);
  } catch (error) {
    const laterEvidence = readPreSubmitEvidence(error);
    if (!laterEvidence) throw error;
    throw new BrowserAutomationError(
      `Pre-submit verification failed for a later submission; this prompt was not sent, but an earlier prompt in this run had already reached the send step. ${laterEvidence.mismatches.join("; ")}`,
      {
        stage: "later-submission-verification",
        code: "later-submission-mismatch",
        laterSubmissionVerification: laterEvidence,
      },
      error,
    );
  }
}

/** Runs a selection owner through the gate when the run has a pre-submit plan. */
export function guardPreSendSelection<T>(
  gate: PreSubmitGate | null,
  stage: PreSendSelectionStage,
  attachmentCount: number,
  action: () => Promise<T>,
): Promise<T> {
  return gate ? gate.guardSelection(stage, attachmentCount, action) : action();
}

function readPreSubmitEvidence(error: unknown): BrowserPreSubmitVerification | undefined {
  if (!(error instanceof BrowserAutomationError)) return undefined;
  return (error.details as { preSubmitVerification?: BrowserPreSubmitVerification } | undefined)
    ?.preSubmitVerification;
}

/** Evidence for a selection owner that failed before the final check could run. */
function buildSelectionFailureEvidence(
  plan: PreSubmitPlan,
  stage: PreSendSelectionStage,
  error: unknown,
  attachmentCount: number,
): BrowserPreSubmitVerification {
  const details =
    error instanceof BrowserAutomationError
      ? (error.details as { code?: string; observed?: Partial<EffortSliderState> } | undefined)
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  // Only the effort owner reports a slider it actually read; everything else stays unobserved.
  const observed = stage === "thinking-time" ? details?.observed : undefined;
  const observedIndex = typeof observed?.value === "number" ? observed.value : null;
  const observedLevel = observedIndex === null ? null : thinkingTimeLevelAtIndex(observedIndex);
  return {
    requestedModel: plan.requestedModel,
    resolvedModelLabel: null,
    modelChecked: false,
    requestedEffort: plan.requestedEffort,
    observedEffortIndex: observedIndex,
    observedEffortLabel: observedLevel ? THINKING_TIME_LABELS[observedLevel] : null,
    effortRangeMin: typeof observed?.min === "number" ? observed.min : null,
    effortRangeMax: typeof observed?.max === "number" ? observed.max : null,
    deepResearchRequested: plan.deepResearch,
    deepResearchTokenPresent: false,
    attachmentCount,
    verified: false,
    stoppedBeforeSubmit: plan.stopBeforeSubmit,
    mismatches: [`${stage}: ${details?.code ?? "failed"}: ${message}`],
    capturedAt: new Date().toISOString(),
  };
}
/**
 * Empties the composer after a stop-before-submit check so the profile keeps no draft.
 * Cleanup problems become warnings; they never change the verification result or send.
 */
export async function clearComposerAfterStop(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  submission: { attachmentCount: number },
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
    const token = await readDeepResearchComposerToken(Runtime);
    if (token.present) {
      throw new Error(
        `Deep Research connector chip is still in the composer (${JSON.stringify(token.occurrences.filter((entry) => entry.accepted))}).`,
      );
    }
  });
  return warnings;
}
