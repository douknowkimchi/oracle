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
import { buildComposerPickerHelpers, type ComposerPickerFailure } from "./composerPicker.js";

/** The current ChatGPT effort slider exposes exactly five steps: Instant..Pro. */
export const EFFORT_SLIDER_MIN = 0;
export const EFFORT_SLIDER_MAX = THINKING_TIME_LEVELS.length - 1;
const KEY_CHANGE_TIMEOUT_MS = 5_000;
const KEY_CHANGE_POLL_MS = 50;

const ARROW_KEYS = {
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  },
  ArrowLeft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
  },
} as const;

export interface EffortSliderState {
  min: number | null;
  max: number | null;
  value: number | null;
  valueText: string | null;
  disabled: boolean;
}

export type EffortSliderRead =
  | { ok: true; state: EffortSliderState }
  | { ok: false; failure: ComposerPickerFailure };

export interface EffortSelectionResult {
  level: ThinkingTimeLevel;
  index: number;
  label: string;
  status: "already-selected" | "switched";
}

type SliderOperation = "read" | "focus" | "read-and-close" | "close";

type SliderProbe =
  | (EffortSliderState & { status: "ok"; focused?: boolean })
  | { status: "closed" }
  | ComposerPickerFailure;

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
): Promise<EffortSliderRead> {
  const probe = await probeSlider(Runtime, "read-and-close");
  if (probe.status === "failed") {
    return { ok: false, failure: probe };
  }
  if (probe.status !== "ok") {
    return { ok: false, failure: { status: "failed", reason: "slider-not-found" } };
  }
  return { ok: true, state: toState(probe) };
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

async function selectEffort(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<EffortSelectionResult> {
  const target = thinkingTimeLevelIndex(level);
  const label = THINKING_TIME_LABELS[level];
  let state = await readUsableSlider(Runtime, "read", level);
  const initial = state.value;
  // Each key press must move one step toward the target, so at most max-min presses are needed.
  for (let presses = 0; state.value !== target; presses += 1) {
    if (presses >= EFFORT_SLIDER_MAX - EFFORT_SLIDER_MIN) {
      throw effortMismatch("effort-step-limit", level, state);
    }
    const focused = await readUsableSlider(Runtime, "focus", level);
    if (focused.value !== state.value) {
      state = focused;
      continue;
    }
    const previous = state.value;
    const key = target > previous ? "ArrowRight" : "ArrowLeft";
    await pressKey(Input, key);
    state = await waitForSliderChange(Runtime, previous, level);
    if (!sliderAdvancedTowardTarget(previous, state.value, target)) {
      throw effortMismatch("effort-key-no-effect", level, state, { key, before: previous });
    }
  }
  const closed = await probeSlider(Runtime, "close");
  if (closed.status === "failed") {
    throw pickerFailureToEffortFailure(closed, level);
  }
  const confirmed = await readUsableSlider(Runtime, "read-and-close", level);
  if (confirmed.value !== target) {
    throw effortMismatch("effort-not-persisted", level, confirmed);
  }
  const status = initial === target ? "already-selected" : "switched";
  logger(
    `${BROWSER_THINKING_LOG_PREFIX} ${label}${status === "already-selected" ? " (already selected)" : ""} [slider ${target}/${EFFORT_SLIDER_MAX}]`,
  );
  return { level, index: target, label, status };
}

async function waitForSliderChange(
  Runtime: ChromeClient["Runtime"],
  previous: number,
  level: ThinkingTimeLevel,
): Promise<UsableSliderState> {
  const deadline = Date.now() + KEY_CHANGE_TIMEOUT_MS;
  let state = await readUsableSlider(Runtime, "read", level);
  while (state.value === previous && Date.now() < deadline) {
    await delay(KEY_CHANGE_POLL_MS);
    state = await readUsableSlider(Runtime, "read", level);
  }
  return state;
}

async function pressKey(Input: ChromeClient["Input"], key: keyof typeof ARROW_KEYS): Promise<void> {
  const event = ARROW_KEYS[key];
  await Input.dispatchKeyEvent({ type: "rawKeyDown", ...event });
  await Input.dispatchKeyEvent({ type: "keyUp", ...event });
}

type UsableSliderState = EffortSliderState & { value: number };

async function readUsableSlider(
  Runtime: ChromeClient["Runtime"],
  operation: Exclude<SliderOperation, "close">,
  level: ThinkingTimeLevel,
): Promise<UsableSliderState> {
  const probe = await probeSlider(Runtime, operation);
  if (probe.status === "failed") {
    throw pickerFailureToEffortFailure(probe, level);
  }
  if (probe.status !== "ok") {
    throw new EffortSelectionFailure("effort-probe-invalid", "Thinking time: unexpected probe.", {
      probe,
    });
  }
  const state = toState(probe);
  const problem = describeEffortSliderProblem(state);
  if (problem) {
    throw new EffortSelectionFailure(
      state.disabled ? "effort-disabled" : "effort-range-invalid",
      `Thinking time: ${problem} while selecting ${THINKING_TIME_LABELS[level]}.`,
      { observed: state },
    );
  }
  return state as UsableSliderState;
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

function toState(probe: EffortSliderState): EffortSliderState {
  return {
    min: probe.min,
    max: probe.max,
    value: probe.value,
    valueText: probe.valueText,
    disabled: probe.disabled,
  };
}

async function probeSlider(
  Runtime: ChromeClient["Runtime"],
  operation: SliderOperation,
): Promise<SliderProbe> {
  const outcome = await Runtime.evaluate({
    expression: buildEffortSliderExpression(operation),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = outcome.result?.value as SliderProbe | undefined;
  return value ?? { status: "failed", reason: "menu-not-bound", diagnostic: { emptyResult: true } };
}

function buildEffortSliderExpression(operation: SliderOperation): string {
  return `(async () => {
    ${buildComposerPickerHelpers()}
    const OPERATION = ${JSON.stringify(operation)};
    if (OPERATION === 'close') {
      const composer = pickerComposerForm();
      if (!composer) return pickerFailure('composer-not-found');
      const trigger = pickerTrigger(composer.form);
      if (!trigger) return pickerFailure('trigger-not-found');
      if (!(await pickerCloseAll(trigger))) {
        return pickerFailure('menu-not-bound', { stillOpen: pickerDescribe(trigger) });
      }
      return { status: 'closed' };
    }
    let opened = await pickerOpenMenu();
    if (opened.failure) return opened.failure;
    // The slider is locked while the model submenu is open: close the picker and reopen it once.
    if (pickerSubTriggers(opened.menu).some(pickerIsOpen)) {
      await pickerCloseAll(opened.trigger);
      opened = await pickerOpenMenu();
      if (opened.failure) return opened.failure;
    }
    const state = pickerReadSlider(opened.menu);
    if (!state) {
      const failure = pickerFailure('slider-not-found', {
        menu: pickerDescribe(opened.menu),
        items: Array.from(opened.menu.querySelectorAll('[role]')).slice(0, 20).map(pickerDescribe),
      });
      await pickerCloseAll(opened.trigger);
      return failure;
    }
    if (OPERATION === 'focus') {
      // Keys go to the slider's menu row, as in the verified Webdex flow.
      const parts = pickerSlider(opened.menu);
      const target = parts.control || parts.slider;
      try {
        target.focus?.({ preventScroll: true });
      } catch {}
      const active = document.activeElement;
      const focused = Boolean(active) && (active === target || Boolean(target.contains?.(active)));
      if (!focused) {
        return pickerFailure('focus-failed', { target: pickerDescribe(target), active: pickerDescribe(active) });
      }
      return { status: 'ok', ...state, focused: true };
    }
    if (OPERATION === 'read-and-close') {
      await pickerCloseAll(opened.trigger);
    }
    return { status: 'ok', ...state };
  })()`;
}
