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
/**
 * Failures a retry must not wash out: Pro refused in different ways is evidence about this run,
 * and starting over would let a later attempt fall back on part of it. Likewise a Pro step seen
 * while relying on its absence contradicts the missing-step fallback; a retry that reads 0..3
 * again must not turn that contradiction into a pro-step-absent fallback.
 */
const FINAL_EFFORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "effort-pro-inconsistent",
  "effort-range-changed",
]);

/** For withRetries: false when the effort owner reported a failure that must end the run. */
export function isRetryableEffortFailure(error: unknown): boolean {
  if (!(error instanceof BrowserAutomationError)) return true;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return !(typeof code === "string" && FINAL_EFFORT_FAILURE_CODES.has(code));
}

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
 * - pro-step-absent: the slider offered only 0..3, at the first and the confirming read.
 * - pro-step-locked: on every attempt ArrowRight at Extra High was refused while the row still
 *   moved 3 -> 2 -> 3.
 * - pro-not-kept: on every attempt the slider reached Pro but read Extra High after reopening.
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
  if (level === "pro") return selectPro(Runtime, Input, logger);
  const target = thinkingTimeLevelIndex(level);
  const opened = usableSlider(await openEffortView(Runtime, Input), level);
  const initial = opened.value;
  await stepTo(Runtime, Input, opened, target, level);
  await closeOrFail(Runtime, Input, level);
  const confirmed = await confirmSlider(Runtime, Input, level, false);
  if (confirmed.value !== target) throw effortMismatch("effort-not-persisted", level, confirmed);
  return finishSelection(logger, level, target, initial, null);
}

/** Times a Pro step must be refused, the same way each time, before a Pro request runs at Extra High. */
const PRO_STEP_ATTEMPTS = 3;

/**
 * Selects Pro. Runs at Extra High only when the picker shows Pro as unavailable:
 * - the slider offers 0..3 (and still does at the confirming read), or
 * - on every one of PRO_STEP_ATTEMPTS attempts, ArrowRight from Extra High is refused while the
 *   row demonstrably takes keys (ArrowLeft then ArrowRight move it 3 -> 2 -> 3), or
 * - on every attempt the slider reaches Pro but reads Extra High after the picker is reopened.
 * A single refusal or revert followed by a kept Pro selects Pro. Anything else fails.
 */
async function selectPro(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<EffortSelectionResult> {
  const level: ThinkingTimeLevel = "pro";
  let state = usableSlider(await openEffortView(Runtime, Input), level, true);
  const initial = state.value;
  if (state.max === PRO_FALLBACK_INDEX) {
    // Every read while relying on the missing step must still show 0..3.
    const reached = await stepTo(Runtime, Input, state, PRO_FALLBACK_INDEX, level, true);
    requireProStepAbsent(reached);
    await closeOrFail(Runtime, Input, level);
    const confirmed = await confirmSlider(Runtime, Input, level, true);
    if (confirmed.max !== PRO_FALLBACK_INDEX) {
      throw new EffortSelectionFailure(
        "effort-range-changed",
        `Thinking time: the slider range changed from 0..${PRO_FALLBACK_INDEX} to 0..${confirmed.max} while selecting Pro.`,
        { observed: confirmed },
      );
    }
    if (confirmed.value !== PRO_FALLBACK_INDEX) {
      throw effortMismatch("effort-not-persisted", level, confirmed);
    }
    return finishSelection(logger, level, PRO_FALLBACK_INDEX, initial, "pro-step-absent");
  }
  if (state.value < PRO_FALLBACK_INDEX) {
    state = await stepTo(Runtime, Input, state, PRO_FALLBACK_INDEX, level);
  }
  const refusals: ProEffortFallbackReason[] = [];
  // A Pro value found already set is checked once without counting; only Oracle's own moves to Pro count.
  for (
    let round = 0;
    refusals.length < PRO_STEP_ATTEMPTS && round <= PRO_STEP_ATTEMPTS;
    round += 1
  ) {
    const pressedToPro = state.value !== EFFORT_SLIDER_MAX;
    if (pressedToPro) {
      const moved = await pressAndRead(Runtime, Input, "ArrowRight", state.value, level);
      if (moved.value === PRO_FALLBACK_INDEX) {
        recordRefusal(refusals, "pro-step-locked");
        state = await proveRowTakesKeys(Runtime, Input, level);
        continue;
      }
      if (moved.value !== EFFORT_SLIDER_MAX) {
        throw effortMismatch("effort-key-no-effect", level, moved, {
          key: "ArrowRight",
          before: PRO_FALLBACK_INDEX,
        });
      }
    }
    await closeOrFail(Runtime, Input, level);
    const confirmed = await confirmSlider(Runtime, Input, level, false);
    if (confirmed.value === EFFORT_SLIDER_MAX) {
      return finishSelection(logger, level, EFFORT_SLIDER_MAX, initial, null);
    }
    if (confirmed.value !== PRO_FALLBACK_INDEX) {
      throw effortMismatch("effort-not-persisted", level, confirmed);
    }
    if (pressedToPro) recordRefusal(refusals, "pro-not-kept");
    state = usableSlider(await openEffortView(Runtime, Input), level);
    if (state.value !== PRO_FALLBACK_INDEX) {
      throw effortMismatch("effort-not-persisted", level, state);
    }
  }
  const reason = refusals[0];
  if (reason === undefined || refusals.length < PRO_STEP_ATTEMPTS) {
    throw effortMismatch("effort-not-persisted", level, state);
  }
  await closeOrFail(Runtime, Input, level);
  const confirmed = await confirmSlider(Runtime, Input, level, false);
  if (confirmed.value !== PRO_FALLBACK_INDEX) {
    throw effortMismatch("effort-not-persisted", level, confirmed);
  }
  return finishSelection(logger, level, PRO_FALLBACK_INDEX, initial, reason);
}

/** Records a refusal and ends the run as soon as two different kinds have been seen. */
function recordRefusal(refusals: ProEffortFallbackReason[], reason: ProEffortFallbackReason): void {
  refusals.push(reason);
  if (refusals.some((entry) => entry !== reason)) {
    throw new EffortSelectionFailure(
      "effort-pro-inconsistent",
      "Thinking time: Pro was refused in different ways across attempts.",
      { refusals: [...refusals] },
    );
  }
}

function requireProStepAbsent(state: UsableSliderState): void {
  if (state.max !== PRO_FALLBACK_INDEX) {
    throw new EffortSelectionFailure(
      "effort-range-changed",
      `Thinking time: the slider range changed to 0..${state.max} while relying on a missing Pro step.`,
      { observed: state },
    );
  }
}

/** After a refused ArrowRight at Extra High: the row must still move 3 -> 2 -> 3. */
async function proveRowTakesKeys(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
): Promise<UsableSliderState> {
  const down = await pressAndRead(Runtime, Input, "ArrowLeft", PRO_FALLBACK_INDEX, level);
  if (down.value !== PRO_FALLBACK_INDEX - 1) {
    throw effortMismatch("effort-key-no-effect", level, down, {
      key: "ArrowLeft",
      before: PRO_FALLBACK_INDEX,
    });
  }
  const up = await pressAndRead(Runtime, Input, "ArrowRight", down.value, level);
  if (up.value !== PRO_FALLBACK_INDEX) {
    throw effortMismatch("effort-key-no-effect", level, up, {
      key: "ArrowRight",
      before: down.value,
    });
  }
  return up;
}

/** Moves one key at a time toward `target`; every press must step toward it without overshooting. */
async function stepTo(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  start: UsableSliderState,
  target: number,
  level: ThinkingTimeLevel,
  allowProStepAbsent = false,
): Promise<UsableSliderState> {
  let state = start;
  for (let presses = 0; state.value !== target; presses += 1) {
    if (presses >= EFFORT_SLIDER_MAX - EFFORT_SLIDER_MIN) {
      throw effortMismatch("effort-step-limit", level, state);
    }
    const previous = state.value;
    const key = target > previous ? "ArrowRight" : "ArrowLeft";
    state = await pressAndRead(Runtime, Input, key, previous, level, allowProStepAbsent);
    if (!sliderAdvancedTowardTarget(previous, state.value, target)) {
      throw effortMismatch("effort-key-no-effect", level, state, { key, before: previous });
    }
  }
  return state;
}

async function pressAndRead(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  key: "ArrowLeft" | "ArrowRight",
  previous: number,
  level: ThinkingTimeLevel,
  allowProStepAbsent = false,
): Promise<UsableSliderState> {
  if (!(await focusPowerRow(Runtime))) {
    throw pickerFailureToEffortFailure(pickerFailure("focus-failed"), level);
  }
  await pressPickerKey(Input, key);
  return waitForSliderChange(Runtime, previous, level, allowProStepAbsent);
}

async function closeOrFail(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
): Promise<void> {
  if (!(await closePicker(Runtime, Input))) {
    throw pickerFailureToEffortFailure(pickerFailure("menu-not-closed"), level);
  }
}

/** Re-reads the slider in a freshly opened picker; this is the value the run proceeds with. */
async function confirmSlider(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
  allowProStepAbsent: boolean,
): Promise<UsableSliderState> {
  const confirmed = await readEffortSlider(Runtime, Input);
  if (!confirmed.ok) throw pickerFailureToEffortFailure(confirmed.failure, level);
  return usableSlider({ ...emptyStateFor(confirmed.state) }, level, allowProStepAbsent);
}

function finishSelection(
  logger: BrowserLogger,
  requested: ThinkingTimeLevel,
  index: number,
  initial: number,
  fallbackReason: ProEffortFallbackReason | null,
): EffortSelectionResult {
  const effective = THINKING_TIME_LEVELS[index];
  const label = THINKING_TIME_LABELS[effective];
  const status = initial === index ? "already-selected" : "switched";
  const note = fallbackReason ? ` (Pro unavailable: ${fallbackReason})` : "";
  logger(
    `${BROWSER_THINKING_LOG_PREFIX} ${label}${status === "already-selected" ? " (already selected)" : ""}${note} [slider ${index}/${EFFORT_SLIDER_MAX}]`,
  );
  return {
    level: effective,
    index,
    label,
    status,
    requestedLevel: requested,
    fallback: fallbackReason ? { from: "pro", reason: fallbackReason } : null,
  };
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
  // While a missing Pro step is relied on, every read (not just the last) must still show 0..3.
  const read = async (): Promise<UsableSliderState> => {
    const observed = usableSlider(await requireBoundMenu(Runtime), level, allowProStepAbsent);
    if (allowProStepAbsent) requireProStepAbsent(observed);
    return observed;
  };
  let state = await read();
  while (state.value === previous && Date.now() < deadline) {
    await delay(KEY_CHANGE_POLL_MS);
    state = await read();
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
