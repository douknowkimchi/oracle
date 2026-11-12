import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeEffortSliderProblem,
  ensureThinkingTime,
  readEffortSlider,
  sliderAdvancedTowardTarget,
} from "../../src/browser/actions/thinkingTime.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  normalizeThinkingTimeLevel,
  thinkingTimeLevelAtIndex,
  thinkingTimeLevelIndex,
} from "../../src/oracle/thinkingTime.js";
import { FakePickerDom, type FakePickerOptions } from "./fakeComposerPicker.js";

function setup(options: FakePickerOptions = {}) {
  const dom = new FakePickerDom({ checkedModel: "GPT-6", ...options });
  const { Runtime, Input } = dom.cdp();
  const logs: string[] = [];
  const logger = ((message: string) => logs.push(message)) as BrowserLogger;
  return { dom, Runtime: Runtime as never, Input: Input as never, logger, logs };
}

async function expectEffortFailure(
  promise: Promise<unknown>,
  code: string,
): Promise<BrowserAutomationError> {
  const error = await promise.then(
    () => {
      throw new Error("expected effort selection to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BrowserAutomationError);
  const failure = error as BrowserAutomationError;
  expect((failure.details as { code?: string }).code).toBe(code);
  expect((failure.details as { stage?: string }).stage).toBe("thinking-time");
  return failure;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("effort level normalization", () => {
  it("maps canonical levels to slider indexes and back", () => {
    expect(
      ["instant", "medium", "high", "extra-high", "pro"].map((level) =>
        thinkingTimeLevelIndex(level as never),
      ),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(thinkingTimeLevelAtIndex(4)).toBe("pro");
    expect(thinkingTimeLevelAtIndex(5)).toBeNull();
    expect(thinkingTimeLevelAtIndex(-1)).toBeNull();
    expect(thinkingTimeLevelAtIndex(1.5)).toBeNull();
  });

  it("keeps the legacy four-level meaning and treats pro as the fifth step", () => {
    expect(normalizeThinkingTimeLevel("light")).toBe("instant");
    expect(normalizeThinkingTimeLevel("standard")).toBe("medium");
    expect(normalizeThinkingTimeLevel("extended")).toBe("high");
    expect(normalizeThinkingTimeLevel("heavy")).toBe("extra-high");
    expect(normalizeThinkingTimeLevel("Extra High")).toBe("extra-high");
    expect(normalizeThinkingTimeLevel("pro")).toBe("pro");
    expect(normalizeThinkingTimeLevel("")).toBeNull();
    expect(normalizeThinkingTimeLevel("max")).toBeNull();
  });
});

describe("effort slider state checks", () => {
  it("accepts only an enabled 0..4 slider with an in-range value", () => {
    const valid = { min: 0, max: 4, value: 4, valueText: null, disabled: false };
    expect(describeEffortSliderProblem(valid)).toBeNull();
    expect(describeEffortSliderProblem({ ...valid, max: 3 })).toMatch(/range 0\.\.3/);
    expect(describeEffortSliderProblem({ ...valid, min: 1 })).toMatch(/range 1\.\.4/);
    expect(describeEffortSliderProblem({ ...valid, value: null })).toMatch(/non-integer/);
    expect(describeEffortSliderProblem({ ...valid, value: 5 })).toMatch(/outside/);
    expect(describeEffortSliderProblem({ ...valid, disabled: true })).toMatch(/disabled/);
  });

  it("requires each key press to move toward the target without overshooting", () => {
    expect(sliderAdvancedTowardTarget(2, 3, 4)).toBe(true);
    expect(sliderAdvancedTowardTarget(2, 2, 4)).toBe(false);
    expect(sliderAdvancedTowardTarget(2, 4, 3)).toBe(false);
    expect(sliderAdvancedTowardTarget(3, 1, 0)).toBe(true);
    expect(sliderAdvancedTowardTarget(3, null, 0)).toBe(false);
  });
});

describe("ensureThinkingTime on the observed Power row", () => {
  it("opens the picker with a click, steps Medium to Pro one key at a time and re-reads after reopening", async () => {
    const { dom, Runtime, Input, logger, logs } = setup({
      effort: { min: "0", max: "4", value: "1" },
    });

    await expect(ensureThinkingTime(Runtime, Input, "pro", logger)).resolves.toEqual({
      level: "pro",
      index: 4,
      label: "Pro",
      status: "switched",
    });

    expect(dom.sentKeys).toEqual(["ArrowRight", "ArrowRight", "ArrowRight", "Escape", "Escape"]);
    expect(dom.clicks).toEqual(["Select ChatGPT model", "Select ChatGPT model"]);
    expect(dom.sliderValue).toBe(4);
    expect(dom.menuOpen).toBe(false);
    expect(logs.join("\n")).toContain("[browser] Thinking time: Pro [slider 4/4]");
  });

  it("moves left for lower levels", async () => {
    const { dom, Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "4" } });

    await ensureThinkingTime(Runtime, Input, "instant", logger);

    expect(dom.sentKeys.filter((key) => key === "ArrowLeft")).toHaveLength(4);
    expect(dom.sliderValue).toBe(0);
  });

  it("sends no arrow keys when the requested level is already selected", async () => {
    const { dom, Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "3" } });

    await expect(ensureThinkingTime(Runtime, Input, "extra-high", logger)).resolves.toMatchObject({
      status: "already-selected",
      index: 3,
    });
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual([]);
  });

  it("closes a picker left in the model view and reads the slider in the simple view", async () => {
    const { dom, Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "2" } });
    dom.toggleMenu();
    dom.showAdvanced();
    expect(dom.powerRow?.getAttribute("aria-disabled")).toBe("true");

    await ensureThinkingTime(Runtime, Input, "high", logger);

    expect(dom.view).toBe("simple");
    expect(dom.menuOpen).toBe(false);
  });

  it("fails when the picker only opens in the model view", async () => {
    const { dom, Runtime, Input, logger } = setup({ reopenInAdvanced: true });

    await expectEffortFailure(ensureThinkingTime(Runtime, Input, "pro", logger), "effort-disabled");
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual([]);
  });

  it("fails before any key press when the slider range is not 0..4", async () => {
    const { dom, Runtime, Input, logger } = setup({ effort: { min: "0", max: "3", value: "1" } });

    const error = await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-range-invalid",
    );

    expect(error.message).toMatch(/range 0\.\.3/);
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual([]);
  });

  it("fails when the slider is locked", async () => {
    const { dom, Runtime, Input, logger } = setup({ sliderAlwaysDisabled: true });

    const error = await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-disabled",
    );
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual([]);
    const details = error.details as { diagnostic?: { powerLockSignals?: string[] } };
    expect(details.diagnostic?.powerLockSignals).toEqual([
      "slider-aria-disabled",
      "slider-data-locked",
    ]);
  });

  it("fails when the Power row itself is aria-disabled in the simple view", async () => {
    const { dom, Runtime, Input, logger } = setup({ powerRowDisabled: true });

    const error = await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-disabled",
    );
    expect(dom.view).toBe("simple");
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual([]);
    const details = error.details as { diagnostic?: { powerLockSignals?: string[] } };
    expect(details.diagnostic?.powerLockSignals).toContain("row-aria-disabled");
  });

  it("does not treat the slider thumb's own aria-hidden as a lock", async () => {
    const { dom, Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "4" } });
    dom.toggleMenu();
    expect(dom.slider?.getAttribute("aria-hidden")).toBe("true");
    dom.closeMenu();

    await expect(readEffortSlider(Runtime, Input)).resolves.toMatchObject({
      ok: true,
      state: { value: 4, disabled: false },
    });
    await expect(ensureThinkingTime(Runtime, Input, "pro", logger)).resolves.toMatchObject({
      status: "already-selected",
      index: 4,
    });
  });

  it("fails when the composer has no model trigger", async () => {
    const { Runtime, Input, logger } = setup({ triggerMissing: true });

    await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-trigger-not-found",
    );
  });

  it("fails when the menu is not bound to the trigger", async () => {
    const { Runtime, Input, logger } = setup({ unboundMenu: true });

    await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-menu-not-bound",
    );
  });

  it("fails when the picker has no effort row", async () => {
    const { Runtime, Input, logger } = setup({ effort: null });

    await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "high", logger),
      "effort-slider-not-found",
    );
  });

  it("fails when a key press leaves the value unchanged", async () => {
    vi.useFakeTimers();
    const { dom, Runtime, Input, logger } = setup({ keyStep: 0 });

    const assertion = expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "pro", logger),
      "effort-key-no-effect",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(dom.sentKeys.filter((key) => key.startsWith("Arrow"))).toEqual(["ArrowRight"]);
  });

  it("fails when a key press overshoots the requested level", async () => {
    const { Runtime, Input, logger } = setup({
      keyStep: 2,
      effort: { min: "0", max: "4", value: "2" },
    });

    await expectEffortFailure(
      ensureThinkingTime(Runtime, Input, "extra-high", logger),
      "effort-key-no-effect",
    );
  });
});

describe("readEffortSlider", () => {
  it("reports the observed range and value and leaves the picker closed", async () => {
    const { dom, Runtime, Input } = setup({ effort: { min: "0", max: "4", value: "4" } });

    await expect(readEffortSlider(Runtime, Input)).resolves.toEqual({
      ok: true,
      state: { min: 0, max: 4, value: 4, valueText: null, disabled: false },
    });
    expect(dom.menuOpen).toBe(false);
  });

  it("does not read a menu whose trigger already reports it closed", async () => {
    // Escape animation: the old menu stays rendered while the trigger already says closed.
    const { dom, Runtime, Input } = setup({ effort: { min: "0", max: "4", value: "1" } });
    dom.menuOpen = true;
    dom.menu.setAttribute("data-state", "open");

    const read = await readEffortSlider(Runtime, Input);

    expect(dom.clicks).toEqual(["Select ChatGPT model"]);
    expect(read).toMatchObject({ ok: true, state: { value: 1 } });
  });

  it("fails when the picker stays open after the read", async () => {
    const { Runtime, Input } = setup({ escapeIgnored: true });

    await expect(readEffortSlider(Runtime, Input)).resolves.toMatchObject({
      ok: false,
      failure: { reason: "menu-not-closed" },
    });
  });

  it("returns the structural failure when no composer form is present", async () => {
    const { dom, Runtime, Input } = setup();
    dom.editor.attached = false;

    await expect(readEffortSlider(Runtime, Input)).resolves.toMatchObject({
      ok: false,
      failure: { reason: "composer-not-found" },
    });
  });
});
