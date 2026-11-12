import { INPUT_SELECTORS } from "../constants.js";
import { buildClickDispatcher } from "./domEvents.js";

/*
 * In-page helpers for ChatGPT's current composer intelligence picker: the composer trigger,
 * the menu bound through its aria-controls, the model submenu, and the effort slider.
 *
 * The trigger selectors, the aria-controls/open-state binding, the hidden semantic slider
 * lookup, and the slider range rules are adapted from codex-chatgpt-web
 * (src/chatgpt-session.ts, src/adapters/chatgpt-web/browser-worker.ts).
 * MIT License, Copyright (c) 2026 codex-chatgpt-web contributors.
 */

/** Composer controls that open the intelligence picker; the last visible one in the form wins. */
const COMPOSER_PICKER_TRIGGER_SELECTORS = [
  'button[data-tone="neutral"][aria-haspopup="menu"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button.__composer-pill[aria-haspopup="menu"]',
] as const;
const EFFORT_SLIDER_CONTAINER_SELECTOR = "[data-model-reasoning-effort-slider]";
const MODEL_SUBMENU_TRIGGER_SELECTOR = '[role="menuitem"][aria-haspopup="menu"]';
const MODEL_SUBMENU_ITEM_SELECTOR = '[role="menuitemradio"]';

/** Failure reasons shared by every picker expression. */
type ComposerPickerFailureReason =
  | "composer-not-found"
  | "trigger-not-found"
  | "menu-not-bound"
  | "slider-not-found"
  | "submenu-not-found"
  | "option-not-found"
  | "option-ambiguous"
  | "focus-failed"
  | "selection-unverified";

export interface ComposerPickerFailure {
  status: "failed";
  reason: ComposerPickerFailureReason;
  diagnostic?: Record<string, unknown>;
}

/**
 * Returns JavaScript source that defines the picker helpers inside a page expression.
 * Every lookup starts again from the single visible composer form, so a re-rendered or
 * closed menu is never read through a stale node.
 */
export function buildComposerPickerHelpers(): string {
  return `
    ${buildClickDispatcher("pickerClick")}
    const PICKER_INPUT_SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
    const PICKER_TRIGGER_SELECTOR = ${JSON.stringify(COMPOSER_PICKER_TRIGGER_SELECTORS.join(", "))};
    const PICKER_SLIDER_CONTAINER_SELECTOR = ${JSON.stringify(EFFORT_SLIDER_CONTAINER_SELECTOR)};
    const PICKER_SUBMENU_TRIGGER_SELECTOR = ${JSON.stringify(MODEL_SUBMENU_TRIGGER_SELECTOR)};
    const PICKER_SUBMENU_ITEM_SELECTOR = ${JSON.stringify(MODEL_SUBMENU_ITEM_SELECTOR)};
    const PICKER_OPEN_WAIT_MS = 3000;
    const PICKER_POLL_MS = 100;
    const PICKER_CLOSE_SETTLE_MS = 150;
    const pickerSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    const pickerDisabled = (node) =>
      Boolean(node) &&
      (node.getAttribute?.('aria-disabled') === 'true' ||
        node.hasAttribute?.('data-disabled') === true ||
        node.disabled === true);
    const pickerDescribe = (node) => {
      if (!node || typeof node.getAttribute !== 'function') return null;
      return {
        tag: String(node.tagName || '').toLowerCase() || null,
        id: node.getAttribute('id'),
        role: node.getAttribute('role'),
        testid: node.getAttribute('data-testid'),
        ariaControls: node.getAttribute('aria-controls'),
        ariaExpanded: node.getAttribute('aria-expanded'),
        ariaChecked: node.getAttribute('aria-checked'),
        ariaDisabled: node.getAttribute('aria-disabled'),
        dataState: node.getAttribute('data-state'),
        ariaLabel: pickerRedact(node.getAttribute('aria-label')),
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
    const pickerTrigger = (form) => {
      const candidates = Array.from(form.querySelectorAll(PICKER_TRIGGER_SELECTOR)).filter(pickerVisible);
      return candidates.length > 0 ? candidates[candidates.length - 1] : null;
    };
    // A layer counts only while its owner is open and the aria-controls target is a live,
    // visible, non-closing element. A menu still animating out after Escape is rejected.
    const pickerBoundLayer = (owner) => {
      if (!owner || !pickerIsOpen(owner)) return null;
      const id = owner.getAttribute?.('aria-controls');
      if (!id) return null;
      const layer = document.getElementById(id);
      if (!layer || layer.isConnected === false || !pickerVisible(layer)) return null;
      if (layer.getAttribute?.('data-state') === 'closed') return null;
      return layer;
    };
    const pickerEscape = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }),
        );
      } catch {}
    };
    const pickerOpenLayer = async (owner) => {
      let layer = pickerBoundLayer(owner);
      if (layer) return layer;
      if (pickerIsOpen(owner)) {
        // Owner claims to be open but exposes no live layer: clear the ghost state first.
        pickerEscape();
        await pickerSleep(PICKER_CLOSE_SETTLE_MS);
      }
      pickerClick(owner);
      const deadline = performance.now() + PICKER_OPEN_WAIT_MS;
      while (performance.now() < deadline) {
        await pickerSleep(PICKER_POLL_MS);
        layer = pickerBoundLayer(owner);
        if (layer) return layer;
      }
      return null;
    };
    const pickerCloseAll = async (trigger) => {
      for (let attempt = 0; attempt < 3 && trigger && pickerIsOpen(trigger); attempt += 1) {
        pickerEscape();
        await pickerSleep(PICKER_CLOSE_SETTLE_MS);
      }
      return !trigger || !pickerIsOpen(trigger);
    };
    const pickerFailure = (reason, extra = {}) => ({ status: 'failed', reason, diagnostic: extra });
    // Resolves composer form -> trigger -> bound menu, opening the menu when needed.
    const pickerOpenMenu = async () => {
      const composer = pickerComposerForm();
      if (!composer) return { failure: pickerFailure('composer-not-found') };
      const trigger = pickerTrigger(composer.form);
      if (!trigger) {
        return {
          failure: pickerFailure('trigger-not-found', {
            menuButtons: Array.from(composer.form.querySelectorAll('button[aria-haspopup]'))
              .slice(0, 8)
              .map(pickerDescribe),
          }),
        };
      }
      const menu = await pickerOpenLayer(trigger);
      if (!menu) {
        const id = trigger.getAttribute('aria-controls');
        const result = {
          failure: pickerFailure('menu-not-bound', {
            trigger: pickerDescribe(trigger),
            controlled: id ? pickerDescribe(document.getElementById(id)) : null,
          }),
        };
        await pickerCloseAll(trigger);
        return result;
      }
      return { composer, trigger, menu };
    };
    const pickerSubTriggers = (menu) =>
      Array.from(menu.querySelectorAll(PICKER_SUBMENU_TRIGGER_SELECTOR)).filter(pickerVisible);
    const pickerSlider = (menu) => {
      const container = menu.querySelector(PICKER_SLIDER_CONTAINER_SELECTOR);
      const slider = (container || menu).querySelector('[role="slider"]');
      if (!slider || !menu.contains(slider)) return null;
      const control = slider.closest?.('[role="menuitem"]');
      return { container, slider, control: control && menu.contains(control) ? control : null };
    };
    const pickerParseInteger = (value) =>
      typeof value === 'string' && /^-?\\d+$/.test(value) ? Number(value) : null;
    const pickerReadSlider = (menu) => {
      const parts = pickerSlider(menu);
      if (!parts) return null;
      const { container, slider, control } = parts;
      return {
        min: pickerParseInteger(slider.getAttribute('aria-valuemin')),
        max: pickerParseInteger(slider.getAttribute('aria-valuemax')),
        value: pickerParseInteger(slider.getAttribute('aria-valuenow')),
        valueText: pickerText(slider.getAttribute('aria-valuetext')) || null,
        disabled: [slider, container, control].some(pickerDisabled),
        containerVisible: container ? pickerVisible(container) : null,
      };
    };
    // Exact item labels: aria-label, full text, and each leaf text node, so a description
    // line under the title cannot turn "GPT-6" into a prefix match.
    const pickerItemLabels = (item) => {
      const labels = [];
      const add = (value) => {
        const text = pickerText(value);
        if (text && !labels.includes(text)) labels.push(text);
      };
      for (const node of item.querySelectorAll('*')) {
        if (!node.children || node.children.length === 0) add(node.textContent);
      }
      add(item.getAttribute('aria-label'));
      add(item.textContent);
      return labels;
    };
    const pickerItemChecked = (item) =>
      item.getAttribute('aria-checked') === 'true' || item.getAttribute('data-state') === 'checked';
    const pickerSubmenuItems = (submenu) =>
      Array.from(submenu.querySelectorAll(PICKER_SUBMENU_ITEM_SELECTOR)).map((node) => ({
        node,
        labels: pickerItemLabels(node),
        checked: pickerItemChecked(node),
      }));
    // Opens the submenu whose bound layer lists the exact target label. Escape closes
    // the whole picker, so the root menu is reopened before trying another candidate.
    const pickerOpenModelSubmenu = async (targetLabel) => {
      const tried = [];
      for (let index = 0; index < 4; index += 1) {
        const opened = await pickerOpenMenu();
        if (opened.failure) return { failure: opened.failure, tried };
        const subTriggers = pickerSubTriggers(opened.menu);
        const subTrigger = subTriggers[index];
        if (!subTrigger) {
          await pickerCloseAll(opened.trigger);
          return {
            failure: pickerFailure(index === 0 ? 'submenu-not-found' : 'option-not-found', { tried }),
            tried,
          };
        }
        const submenu = await pickerOpenLayer(subTrigger);
        if (!submenu) {
          tried.push({ subTrigger: pickerDescribe(subTrigger), opened: false });
          await pickerCloseAll(opened.trigger);
          continue;
        }
        const items = pickerSubmenuItems(submenu);
        const matches = items.filter((item) => item.labels.includes(targetLabel));
        if (matches.length > 0) {
          return { ...opened, subTrigger, submenu, items, matches, tried };
        }
        tried.push({
          subTrigger: pickerDescribe(subTrigger),
          opened: true,
          labels: items.map((item) => pickerRedact(item.labels[0] ?? '', 60)),
        });
        await pickerCloseAll(opened.trigger);
      }
      return { failure: pickerFailure('option-not-found', { tried }), tried };
    };
    const pickerPrimaryLabel = (item, knownLabel = null) =>
      knownLabel && item.labels.includes(knownLabel) ? knownLabel : (item.labels[0] ?? null);
  `;
}
