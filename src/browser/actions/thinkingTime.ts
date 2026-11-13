import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import {
  THINKING_TIME_LABELS,
  THINKING_TIME_LEVELS,
  thinkingTimeLevelIndex,
} from "../../oracle/thinkingTime.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { logDomFailure } from "../domDebug.js";
import { delay } from "../utils.js";
import {
  closePicker,
  focusPowerRow,
  openPicker,
  pickerFailure,
  pressPickerKey,
  readPickerState,
  type ComposerPickerFailure,
  type PickerSliderState,
  type PickerState,
} from "./composerPicker.js";

/** The current ChatGPT effort slider exposes exactly five steps: Instant..Pro. */
export const EFFORT_SLIDER_MIN = 0;
export const EFFORT_SLIDER_MAX = THINKING_TIME_LEVELS.length - 1;
/** Slider index of Extra High, the step used when a Pro request cannot reach Pro. */
const PRO_FALLBACK_INDEX = EFFORT_SLIDER_MAX - 1;
const KEY_CHANGE_TIMEOUT_MS = 5_000;
const KEY_CHANGE_POLL_MS = 50;

export type EffortSliderState = PickerSliderState;

export type EffortSliderRead =
  | { ok: true; state: EffortSliderState }
  | { ok: false; failure: ComposerPickerFailure };

/**
 * Why a Pro request ran at Extra High. Each reason is something the picker showed:
 * - pro-step-absent: the slider offered only 0..3.
 * - pro-step-locked: ArrowRight at Extra High did not move the slider.
 * - pro-not-kept: the slider reached Pro but read Extra High after the picker was reopened.
 */
export type ProEffortFallbackReason = "pro-step-absent" | "pro-step-locked" | "pro-not-kept";

export interface EffortFallback {
  from: "pro";
  reason: ProEffortFallbackReason;
}

export interface EffortSelectionResult {
  /** Level the slider was confirmed at; Extra High when a Pro request fell back. */
  level: ThinkingTimeLevel;
  index: number;
  label: string;
  status: "already-selected" | "switched";
  /** Requested level; differs from `level` only for a Pro fallback. */
  requestedLevel: ThinkingTimeLevel;
  fallback: EffortFallback | null;
}

const BROWSER_THINKING_LOG_PREFIX = "[browser] Thinking time:";

/**
 * Sets ChatGPT's composer effort slider to the requested level and proves it by reading the
 * slider again after the picker is closed and reopened. Every unexpected state (missing or
 * stale menu, locked slider, range other than 0..4, a key press that does not move the value)
 * throws a BrowserAutomationError before any prompt is submitted.
 *
 * One exception keeps a Pro request running: when the picker shows Pro as unavailable (see
 * ProEffortFallbackReason), the slider is confirmed at Extra High and the result says so.
 * Any other problem still fails, and no other level is ever substituted.
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<EffortSelectionResult> {
  try {
    return await selectEffort(Runtime, Input, level, logger);
  } catch (error) {
    if (!(error instanceof EffortSelectionFailure)) throw error;
    await logDomFailure(Runtime, logger, `thinking-${error.code}`);
    logger(`${BROWSER_THINKING_LOG_PREFIX} ${error.message} ${JSON.stringify(error.details)}`);
    throw new BrowserAutomationError(`${error.message} Refusing to submit.`, {
      stage: "thinking-time",
      code: error.code,
      requestedEffort: level,
      ...error.details,
    });
  }
}

/** Reads the effort slider through the composer picker and closes the picker again. */
export async function readEffortSlider(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
): Promise<EffortSliderRead> {
  const opened = await openEffortView(Runtime, Input);
  if ("status" in opened) return { ok: false, failure: opened };
  const slider = opened.slider;
  if (!(await closePicker(Runtime, Input))) {
    return { ok: false, failure: pickerFailure("menu-not-closed", opened.diagnostic) };
  }
  if (!slider) return { ok: false, failure: pickerFailure("slider-not-found", opened.diagnostic) };
  return { ok: true, state: slider };
}

/** Problems that make an observed slider unusable as evidence, in check order. */
export function describeEffortSliderProblem(
  state: EffortSliderState,
  options: { allowProStepAbsent?: boolean } = {},
): string | null {
  if (state.min === null || state.max === null || state.value === null) {
    return "slider exposed a non-integer ARIA range";
  }
  const rangeOk =
    state.min === EFFORT_SLIDER_MIN &&
    (state.max === EFFORT_SLIDER_MAX ||
      (options.allowProStepAbsent === true && state.max === PRO_FALLBACK_INDEX));
  if (!rangeOk) {
    return `slider range ${state.min}..${state.max} (expected ${EFFORT_SLIDER_MIN}..${EFFORT_SLIDER_MAX})`;
  }
  if (state.value < state.min || state.value > state.max) {
    return `slider value ${state.value} outside ${state.min}..${state.max}`;
  }
  if (state.disabled) {
    return "slider is disabled";
  }
  return null;
}

/** Adapted from codex-chatgpt-web chatGptEffortSliderAdvancedTowardTarget (MIT). */
export function sliderAdvancedTowardTarget(
  previous: number,
  current: number | null,
  target: number,
): boolean {
  if (current === null) return false;
  return target > previous
    ? current > previous && current <= target
    : current < previous && current >= target;
}

class EffortSelectionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Opens the picker in the view that shows the effort row. The advanced (model) view locks the
 * row, so an advanced view left over from model selection is closed and reopened once.
 */
async function openEffortView(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
): Promise<PickerState | ComposerPickerFailure> {
  let opened = await openPicker(Runtime, Input);
  if ("status" in opened) return opened;
  if (opened.view === "advanced") {
    if (!(await closePicker(Runtime, Input))) {
      return pickerFailure("menu-not-closed", opened.diagnostic);
    }
    opened = await openPicker(Runtime, Input);
    if ("status" in opened) return opened;
  }
  return opened;
}

async function selectEffort(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<EffortSelectionResult> {
  const wantsPro = level === "pro";
  let target = thinkingTimeLevelIndex(level);
  let fallback: EffortFallback | null = null;
  let state = usableSlider(await openEffortView(Runtime, Input), level, wantsPro);
  const initial = state.value;
  if (wantsPro && state.max === PRO_FALLBACK_INDEX) {
    target = PRO_FALLBACK_INDEX;
    fallback = { from: "pro", reason: "pro-step-absent" };
  }
  // Each key press must move one step toward the target, so at most max-min presses are needed.
  for (let presses = 0; state.value !== target; presses += 1) {
    if (presses >= EFFORT_SLIDER_MAX - EFFORT_SLIDER_MIN) {
      throw effortMismatch("effort-step-limit", level, state);
    }
    if (!(await focusPowerRow(Runtime))) {
      throw pickerFailureToEffortFailure(pickerFailure("focus-failed"), level);
    }
    const previous = state.value;
    const key = target > previous ? "ArrowRight" : "ArrowLeft";
    await pressPickerKey(Input, key);
    state = await waitForSliderChange(Runtime, previous, level, fallback !== null);
    if (!sliderAdvancedTowardTarget(previous, state.value, target)) {
      if (
        wantsPro &&
        fallback === null &&
        key === "ArrowRight" &&
        previous === PRO_FALLBACK_INDEX &&
        state.value === PRO_FALLBACK_INDEX
      ) {
        // Pro is the next step and the slider refused it: run at Extra High instead.
        target = PRO_FALLBACK_INDEX;
        fallback = { from: "pro", reason: "pro-step-locked" };
        break;
      }
      throw effortMismatch("effort-key-no-effect", level, state, { key, before: previous });
    }
  }
  if (!(await closePicker(Runtime, Input))) {
    throw pickerFailureToEffortFailure(pickerFailure("menu-not-closed"), level);
  }
  const confirmed = await readEffortSlider(Runtime, Input);
  if (!confirmed.ok) throw pickerFailureToEffortFailure(confirmed.failure, level);
  const confirmedState = usableSlider(
    { ...emptyStateFor(confirmed.state) },
    level,
    fallback?.reason === "pro-step-absent",
  );
  if (
    wantsPro &&
    fallback === null &&
    target === EFFORT_SLIDER_MAX &&
    confirmedState.value === PRO_FALLBACK_INDEX
  ) {
    // The slider showed Pro, then the page put it back to Extra High.
    target = PRO_FALLBACK_INDEX;
    fallback = { from: "pro", reason: "pro-not-kept" };
  }
  if (confirmedState.value !== target) {
    throw effortMismatch("effort-not-persisted", level, confirmedState);
  }
  const effective = THINKING_TIME_LEVELS[target];
  const label = THINKING_TIME_LABELS[effective];
  const status = initial === target ? "already-selected" : "switched";
  const note = fallback ? ` (Pro unavailable: ${fallback.reason})` : "";
  logger(
    `${BROWSER_THINKING_LOG_PREFIX} ${label}${status === "already-selected" ? " (already selected)" : ""}${note} [slider ${target}/${EFFORT_SLIDER_MAX}]`,
  );
  return { level: effective, index: target, label, status, requestedLevel: level, fallback };
}

function emptyStateFor(slider: EffortSliderState): PickerState {
  return {
    composerFound: true,
    triggerCount: 1,
    trigger: null,
    menuBound: true,
    view: "simple",
    viewToggle: null,
    slider,
    rows: [],
    diagnostic: {},
  };
}

async function waitForSliderChange(
  Runtime: ChromeClient["Runtime"],
  previous: number,
  level: ThinkingTimeLevel,
  allowProStepAbsent: boolean,
): Promise<UsableSliderState> {
  const deadline = Date.now() + KEY_CHANGE_TIMEOUT_MS;
  let state = usableSlider(await requireBoundMenu(Runtime), level, allowProStepAbsent);
  while (state.value === previous && Date.now() < deadline) {
    await delay(KEY_CHANGE_POLL_MS);
    state = usableSlider(await requireBoundMenu(Runtime), level, allowProStepAbsent);
  }
  return state;
}

/** While pressing keys the menu must stay open; a closed or replaced menu is a failure. */
async function requireBoundMenu(
  Runtime: ChromeClient["Runtime"],
): Promise<PickerState | ComposerPickerFailure> {
  const state = await readPickerState(Runtime);
  return state.menuBound ? state : pickerFailure("menu-not-bound", state.diagnostic);
}

type UsableSliderState = EffortSliderState & { value: number };

function usableSlider(
  opened: PickerState | ComposerPickerFailure,
  level: ThinkingTimeLevel,
  allowProStepAbsent = false,
): UsableSliderState {
  if ("status" in opened) throw pickerFailureToEffortFailure(opened, level);
  if (opened.view === "advanced") {
    throw new EffortSelectionFailure(
      "effort-disabled",
      `Thinking time: the picker stayed in the model view while selecting ${THINKING_TIME_LABELS[level]}.`,
      { view: opened.view, diagnostic: opened.diagnostic },
    );
  }
  if (!opened.slider) {
    throw pickerFailureToEffortFailure(pickerFailure("slider-not-found", opened.diagnostic), level);
  }
  const problem = describeEffortSliderProblem(opened.slider, { allowProStepAbsent });
  if (problem) {
    throw new EffortSelectionFailure(
      opened.slider.disabled ? "effort-disabled" : "effort-range-invalid",
      `Thinking time: ${problem} while selecting ${THINKING_TIME_LABELS[level]}.`,
      { observed: opened.slider, diagnostic: opened.diagnostic },
    );
  }
  return opened.slider as UsableSliderState;
}

function pickerFailureToEffortFailure(
  failure: ComposerPickerFailure,
  level: ThinkingTimeLevel,
): EffortSelectionFailure {
  return new EffortSelectionFailure(
    `effort-${failure.reason}`,
    `Thinking time: ${failure.reason.replaceAll("-", " ")} while selecting ${THINKING_TIME_LABELS[level]}.`,
    { diagnostic: failure.diagnostic },
  );
}

function effortMismatch(
  code: string,
  level: ThinkingTimeLevel,
  state: EffortSliderState,
  extra: Record<string, unknown> = {},
): EffortSelectionFailure {
  return new EffortSelectionFailure(
    code,
    `Thinking time: slider is at ${state.value} instead of ${thinkingTimeLevelIndex(level)} (${THINKING_TIME_LABELS[level]}).`,
    { observed: state, ...extra },
  );
}
