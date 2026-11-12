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
const KEY_CHANGE_TIMEOUT_MS = 5_000;
const KEY_CHANGE_POLL_MS = 50;

export type EffortSliderState = PickerSliderState;

export type EffortSliderRead =
  | { ok: true; state: EffortSliderState }
  | { ok: false; failure: ComposerPickerFailure };

export interface EffortSelectionResult {
  level: ThinkingTimeLevel;
  index: number;
  label: string;
  status: "already-selected" | "switched";
}

const BROWSER_THINKING_LOG_PREFIX = "[browser] Thinking time:";

/**
 * Sets ChatGPT's composer effort slider to the requested level and proves it by reading the
 * slider again after the picker is closed and reopened. Every unexpected state (missing or
 * stale menu, locked slider, range other than 0..4, a key press that does not move the value)
 * throws a BrowserAutomationError before any prompt is submitted.
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
export function describeEffortSliderProblem(state: EffortSliderState): string | null {
  if (state.min === null || state.max === null || state.value === null) {
    return "slider exposed a non-integer ARIA range";
  }
  if (state.min !== EFFORT_SLIDER_MIN || state.max !== EFFORT_SLIDER_MAX) {
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
  const target = thinkingTimeLevelIndex(level);
  const label = THINKING_TIME_LABELS[level];
  let state = usableSlider(await openEffortView(Runtime, Input), level);
  const initial = state.value;
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
    state = await waitForSliderChange(Runtime, previous, level);
    if (!sliderAdvancedTowardTarget(previous, state.value, target)) {
      throw effortMismatch("effort-key-no-effect", level, state, { key, before: previous });
    }
  }
  if (!(await closePicker(Runtime, Input))) {
    throw pickerFailureToEffortFailure(pickerFailure("menu-not-closed"), level);
  }
  const confirmed = await readEffortSlider(Runtime, Input);
  if (!confirmed.ok) throw pickerFailureToEffortFailure(confirmed.failure, level);
  const confirmedState = usableSlider({ ...emptyStateFor(confirmed.state) }, level);
  if (confirmedState.value !== target) {
    throw effortMismatch("effort-not-persisted", level, confirmedState);
  }
  const status = initial === target ? "already-selected" : "switched";
  logger(
    `${BROWSER_THINKING_LOG_PREFIX} ${label}${status === "already-selected" ? " (already selected)" : ""} [slider ${target}/${EFFORT_SLIDER_MAX}]`,
  );
  return { level, index: target, label, status };
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
): Promise<UsableSliderState> {
  const deadline = Date.now() + KEY_CHANGE_TIMEOUT_MS;
  let state = usableSlider(await requireBoundMenu(Runtime), level);
  while (state.value === previous && Date.now() < deadline) {
    await delay(KEY_CHANGE_POLL_MS);
    state = usableSlider(await requireBoundMenu(Runtime), level);
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
  const problem = describeEffortSliderProblem(opened.slider);
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
