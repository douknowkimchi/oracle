import type { ChromeClient } from "../types.js";
import { INPUT_SELECTORS } from "../constants.js";
import { delay } from "../utils.js";

/*
 * ChatGPT composer intelligence picker, as observed on the product profile (CT125, 2026-11-13):
 * - trigger: `button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]` in the composer form;
 *   once open, its aria-controls names the `[role="menu"][data-state="open"]` content.
 * - one menu with `[data-model-picker-view="simple"|"advanced"]`. Simple shows the effort row
 *   `[role="menuitem"][data-reasoning-slider="true"]` with `[role="slider"]` (0..4); the model rows
 *   `[role="menuitemradio"]` are in the DOM (aria-checked readable) but covered. The
 *   `[data-model-picker-view-toggle="true"]` row switches to advanced, where model rows are
 *   clickable and the effort row becomes inert/aria-hidden/aria-disabled.
 * - trusted CDP mouse clicks open the trigger and select rows; the effort row takes CDP arrow keys
 *   after element.focus(); one Escape closes the menu.
 * Page code below only reads state and hit-tests; every click and key goes through CDP.
 *
 * The aria-controls/open-state binding and slider range rules are adapted from codex-chatgpt-web
 * (src/chatgpt-session.ts). MIT License, Copyright (c) 2026 codex-chatgpt-web contributors.
 */

const PICKER_TRIGGER_SELECTOR = 'button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]';
const VIEW_SELECTOR = "[data-model-picker-view]";
const VIEW_TOGGLE_SELECTOR = '[role="menuitem"][data-model-picker-view-toggle="true"]';
const POWER_ROW_SELECTOR = '[role="menuitem"][data-reasoning-slider="true"]';
const MODEL_ROW_SELECTOR = '[role="menuitemradio"]';
const OPEN_WAIT_MS = 3_000;
const POLL_MS = 100;

/** Failure reasons shared by picker owners. */
export type ComposerPickerFailureReason =
  | "composer-not-found"
  | "trigger-not-found"
  | "trigger-not-clickable"
  | "menu-not-bound"
  | "menu-not-closed"
  | "slider-not-found"
  | "view-not-advanced"
  | "option-not-found"
  | "option-ambiguous"
  | "option-not-clickable"
  | "focus-failed"
  | "selection-unverified";

export interface ComposerPickerFailure {
  status: "failed";
  reason: ComposerPickerFailureReason;
  diagnostic?: Record<string, unknown>;
}

export interface ClickPoint {
  x: number;
  y: number;
  /** True when elementFromPoint at the center lands on the element (not covered). */
  hit: boolean;
}

export interface PickerModelRow extends ClickPoint {
  /** Title from the observed row structure; null when the title cannot be told apart. */
  title: string | null;
  checked: boolean;
}

export interface PickerSliderState {
  min: number | null;
  max: number | null;
  value: number | null;
  valueText: string | null;
  /** Row or slider locked: aria-disabled/data-disabled/data-locked, inert or aria-hidden. */
  disabled: boolean;
}

export interface PickerState {
  composerFound: boolean;
  triggerCount: number;
  trigger: (ClickPoint & { open: boolean }) | null;
  /** Bound only while the trigger is open and aria-controls names a live, open menu. */
  menuBound: boolean;
  view: string | null;
  viewToggle: ClickPoint | null;
  slider: PickerSliderState | null;
  rows: PickerModelRow[];
  diagnostic: Record<string, unknown>;
}

/** Shared page helpers: composer form, trigger, bound menu and hit-testing. */
export function buildComposerPickerHelpers(): string {
  return `
    const PICKER_INPUT_SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
    const PICKER_TRIGGER_SELECTOR = ${JSON.stringify(PICKER_TRIGGER_SELECTOR)};
    const pickerText = (value) => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const pickerRedact = (value, maxLength = 80) =>
      pickerText(value)
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/\\b[A-Za-z0-9_-]{32,}\\b/g, '[redacted]')
        .slice(0, maxLength);
    const pickerVisible = (node) => {
      if (!node || node.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
    const pickerIsOpen = (node) =>
      node?.getAttribute?.('aria-expanded') === 'true' || node?.getAttribute?.('data-state') === 'open';
    const pickerDescribe = (node) => {
      if (!node || typeof node.getAttribute !== 'function') return null;
      return {
        tag: String(node.tagName || '').toLowerCase() || null,
        role: node.getAttribute('role'),
        ariaLabel: pickerRedact(node.getAttribute('aria-label')),
        ariaControls: node.getAttribute('aria-controls'),
        ariaExpanded: node.getAttribute('aria-expanded'),
        ariaChecked: node.getAttribute('aria-checked'),
        ariaDisabled: node.getAttribute('aria-disabled'),
        dataState: node.getAttribute('data-state'),
        text: pickerRedact(node.textContent),
        visible: pickerVisible(node),
      };
    };
    const pickerComposerForm = () => {
      const editors = [];
      for (const selector of PICKER_INPUT_SELECTORS) {
        for (const node of document.querySelectorAll(selector)) {
          if (pickerVisible(node) && !editors.includes(node)) editors.push(node);
        }
      }
      const forms = [];
      for (const editor of editors) {
        const form = editor.closest?.('form');
        if (form && !forms.includes(form)) forms.push(form);
      }
      return forms.length === 1 ? { form: forms[0], editor: editors.find((e) => forms[0].contains(e)) } : null;
    };
    const pickerTriggers = (form) =>
      Array.from(form.querySelectorAll(PICKER_TRIGGER_SELECTOR)).filter(pickerVisible);
    // A menu counts only while its owner is open and aria-controls names a live, visible,
    // non-closing element; a menu still animating out after Escape is rejected.
    const pickerBoundLayer = (owner) => {
      if (!owner || !pickerIsOpen(owner)) return null;
      const id = owner.getAttribute?.('aria-controls');
      if (!id) return null;
      const layer = document.getElementById(id);
      if (!layer || layer.isConnected === false || !pickerVisible(layer)) return null;
      if (layer.getAttribute?.('data-state') === 'closed') return null;
      return layer;
    };
    const pickerHit = (node) => {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const top = document.elementFromPoint?.(x, y) ?? null;
      return { x, y, hit: Boolean(top) && (top === node || Boolean(node.contains?.(top))) };
    };
  `;
}

function buildPickerStateExpression(): string {
  return `(() => {
    ${buildComposerPickerHelpers()}
    const parseInteger = (value) =>
      typeof value === 'string' && /^-?\\d+$/.test(value) ? Number(value) : null;
    // Observed row: div[role=menuitemradio] > div[data-menu-row-content="true"] > span(title)
    // (+ checkmark svg). The title counts only when that is the row's single content block with a
    // single span and the span's text is the whole row text; any other shape has no title.
    const rowTitle = (row) => {
      const blocks = Array.from(row.children || []).filter(
        (child) => child.getAttribute?.('data-menu-row-content') === 'true',
      );
      if (blocks.length !== 1) return null;
      const spans = Array.from(blocks[0].children || []).filter(
        (child) => String(child.tagName || '').toLowerCase() === 'span',
      );
      if (spans.length !== 1) return null;
      const title = pickerText(spans[0].textContent);
      return title && title === pickerText(row.textContent) ? title : null;
    };
    const composer = pickerComposerForm();
    const empty = {
      composerFound: Boolean(composer), triggerCount: 0, trigger: null, menuBound: false, view: null,
      viewToggle: null, slider: null, rows: [], diagnostic: {},
    };
    if (!composer) return empty;
    const triggers = pickerTriggers(composer.form);
    if (triggers.length !== 1) {
      return {
        ...empty,
        triggerCount: triggers.length,
        diagnostic: {
          menuButtons: Array.from(composer.form.querySelectorAll('button')).slice(0, 8).map(pickerDescribe),
        },
      };
    }
    const trigger = triggers[0];
    const triggerPoint = pickerHit(trigger);
    const menu = pickerBoundLayer(trigger);
    const base = {
      ...empty,
      triggerCount: 1,
      trigger: triggerPoint ? { ...triggerPoint, open: pickerIsOpen(trigger) } : null,
      diagnostic: { trigger: pickerDescribe(trigger) },
    };
    if (!menu) {
      const id = trigger.getAttribute('aria-controls');
      return { ...base, diagnostic: { ...base.diagnostic, controlled: id ? pickerDescribe(document.getElementById(id)) : null } };
    }
    const viewNode = menu.querySelector('${VIEW_SELECTOR}');
    const toggle = menu.querySelector('${VIEW_TOGGLE_SELECTOR}');
    const row = menu.querySelector('${POWER_ROW_SELECTOR}');
    const slider = row?.querySelector('[role="slider"]') ?? null;
    const locked = (node) =>
      Boolean(node) && (
        node.getAttribute('aria-disabled') === 'true' ||
        node.hasAttribute('data-disabled') ||
        Boolean(node.closest?.('[inert]')) ||
        Boolean(node.closest?.('[aria-hidden="true"]')) ||
        Boolean(node.closest?.('[data-locked="true"]')) ||
        Boolean(node.closest?.('[aria-disabled="true"]'))
      );
    const rows = Array.from(menu.querySelectorAll('${MODEL_ROW_SELECTOR}')).map((radio) => {
      const point = pickerHit(radio) ?? { x: 0, y: 0, hit: false };
      return {
        ...point,
        hit: point.hit && !radio.closest?.('[inert]'),
        title: rowTitle(radio),
        checked: radio.getAttribute('aria-checked') === 'true',
      };
    });
    const togglePoint = toggle ? pickerHit(toggle) : null;
    return {
      ...base,
      menuBound: true,
      view: viewNode?.getAttribute('data-model-picker-view') ?? null,
      viewToggle: togglePoint ? { ...togglePoint, hit: togglePoint.hit && !toggle.closest('[inert]') } : null,
      slider: slider
        ? {
            min: parseInteger(slider.getAttribute('aria-valuemin')),
            max: parseInteger(slider.getAttribute('aria-valuemax')),
            value: parseInteger(slider.getAttribute('aria-valuenow')),
            valueText: pickerText(slider.getAttribute('aria-valuetext')) || null,
            disabled: locked(row) || locked(slider),
          }
        : null,
      rows,
      diagnostic: {
        ...base.diagnostic,
        menu: pickerDescribe(menu),
        powerRow: pickerDescribe(row),
      },
    };
  })()`;
}

/** Reads the picker without changing it. */
export async function readPickerState(Runtime: ChromeClient["Runtime"]): Promise<PickerState> {
  const { result } = await Runtime.evaluate({
    expression: buildPickerStateExpression(),
    returnByValue: true,
  });
  return (
    (result?.value as PickerState | undefined) ?? {
      composerFound: false,
      triggerCount: 0,
      trigger: null,
      menuBound: false,
      view: null,
      viewToggle: null,
      slider: null,
      rows: [],
      diagnostic: { emptyResult: true },
    }
  );
}

export function pickerFailure(
  reason: ComposerPickerFailureReason,
  diagnostic: Record<string, unknown> = {},
): ComposerPickerFailure {
  return { status: "failed", reason, diagnostic };
}

/** Trusted CDP click at a point, the way the product-profile probe opened and selected. */
export async function clickPoint(Input: ChromeClient["Input"], point: { x: number; y: number }) {
  const { x, y } = point;
  await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS = {
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ArrowLeft: {
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
    nativeVirtualKeyCode: 37,
  },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  },
} as const;

export async function pressPickerKey(Input: ChromeClient["Input"], key: keyof typeof KEYS) {
  await Input.dispatchKeyEvent({ type: "rawKeyDown", ...KEYS[key] });
  await Input.dispatchKeyEvent({ type: "keyUp", ...KEYS[key] });
}

/** Waits until `ready(state)` holds, re-reading the picker every POLL_MS. */
export async function waitForPickerState(
  Runtime: ChromeClient["Runtime"],
  ready: (state: PickerState) => boolean,
  timeoutMs = OPEN_WAIT_MS,
): Promise<PickerState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readPickerState(Runtime);
  while (!ready(state) && Date.now() < deadline) {
    await delay(POLL_MS);
    state = await readPickerState(Runtime);
  }
  return state;
}

/** Opens the picker with a trusted click on the trigger and returns the bound-menu state. */
export async function openPicker(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
): Promise<PickerState | ComposerPickerFailure> {
  let state = await readPickerState(Runtime);
  if (state.menuBound) return state;
  if (!state.composerFound) return pickerFailure("composer-not-found");
  if (state.triggerCount !== 1 || !state.trigger) {
    return pickerFailure("trigger-not-found", {
      triggerCount: state.triggerCount,
      ...state.diagnostic,
    });
  }
  if (state.trigger.open) {
    // Owner claims to be open but exposes no live menu: clear the ghost state first.
    await closePicker(Runtime, Input);
    state = await readPickerState(Runtime);
  }
  if (!state.trigger?.hit) {
    return pickerFailure("trigger-not-clickable", state.diagnostic);
  }
  await clickPoint(Input, state.trigger);
  state = await waitForPickerState(Runtime, (next) => next.menuBound);
  return state.menuBound ? state : pickerFailure("menu-not-bound", state.diagnostic);
}

/** Closes the picker with Escape and confirms the trigger reports closed. */
export async function closePicker(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await readPickerState(Runtime);
    if (!state.trigger?.open && !state.menuBound) return true;
    await pressPickerKey(Input, "Escape");
    await waitForPickerState(Runtime, (next) => !next.trigger?.open && !next.menuBound, 1_000);
  }
  const final = await readPickerState(Runtime);
  return !final.trigger?.open && !final.menuBound;
}

/** Runs `action` on the open picker and requires the picker to be closed afterwards. */
export async function withOpenPicker<T>(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  action: (state: PickerState) => Promise<T | ComposerPickerFailure>,
): Promise<T | ComposerPickerFailure> {
  const opened = await openPicker(Runtime, Input);
  if ("status" in opened) return opened;
  const result = await action(opened);
  if (!(await closePicker(Runtime, Input))) {
    // An open picker can swallow the later send click: an unclosed read is not evidence.
    return pickerFailure("menu-not-closed", (await readPickerState(Runtime)).diagnostic);
  }
  return result;
}

/** Focuses the effort row (the observed key target) and reports whether focus landed there. */
export async function focusPowerRow(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      ${buildComposerPickerHelpers()}
      const composer = pickerComposerForm();
      const trigger = composer ? pickerTriggers(composer.form)[0] : null;
      const menu = pickerBoundLayer(trigger);
      const row = menu?.querySelector('${POWER_ROW_SELECTOR}');
      if (!row) return false;
      try { row.focus({ preventScroll: true }); } catch {}
      return document.activeElement === row;
    })()`,
    returnByValue: true,
  });
  return result?.value === true;
}
