import { describe, expect, it, vi } from "vitest";
import {
  clearComposerAfterStop,
  createPreSubmitGate,
  guardPreSendSelection,
  resolvePreSubmitPlan,
  verifyComposerBeforeSubmit,
  type PreSubmitPlan,
} from "../../src/browser/actions/preSubmitVerification.js";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";
import { ensureThinkingTime } from "../../src/browser/actions/thinkingTime.js";
import { activateDeepResearch } from "../../src/browser/actions/deepResearch.js";
import { withRetries } from "../../src/browser/utils.js";
import type { BrowserLogger } from "../../src/browser/types.js";
import type { BrowserPreSubmitVerification } from "../../src/sessionStore.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { FakePickerDom, type FakePickerOptions } from "./fakeComposerPicker.js";

const PLAN: PreSubmitPlan = {
  requestedModel: "gpt-6",
  modelLabel: "GPT-6",
  requestedEffort: "pro",
  deepResearch: true,
  stopBeforeSubmit: false,
};

/** Observed ready state: GPT-6 checked, effort Pro, Deep Research mention plus prompt text. */
function setup(options: FakePickerOptions = {}) {
  const dom = new FakePickerDom({
    checkedModel: "GPT-6",
    effort: { min: "0", max: "4", value: "4" },
    deepResearch: "mention",
    prompt: "Research the market.",
    ...options,
  });
  const { Runtime, Input } = dom.cdp();
  const logs: string[] = [];
  const logger = ((message: string) => logs.push(message)) as BrowserLogger;
  return { dom, Runtime: Runtime as never, Input: Input as never, logger, logs };
}

/** Runs `run` with fake timers so multi-second picker waits elapse instantly. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

async function verificationFailure(
  promise: Promise<unknown>,
): Promise<BrowserPreSubmitVerification> {
  const error = await promise.then(
    () => {
      throw new Error("expected verification to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BrowserAutomationError);
  const details = (error as BrowserAutomationError).details as {
    stage?: string;
    preSubmitVerification?: BrowserPreSubmitVerification;
  };
  expect(details.stage).toBe("pre-submit-verification");
  expect(details.preSubmitVerification?.verified).toBe(false);
  return details.preSubmitVerification as BrowserPreSubmitVerification;
}

describe("resolvePreSubmitPlan", () => {
  const base = {
    desiredModel: "GPT-6",
    modelStrategy: "select" as const,
    thinkingTime: "pro" as const,
    researchMode: "deep" as const,
    stopBeforeSubmit: false,
  };

  it("verifies exact model titles, effort and Deep Research", () => {
    expect(resolvePreSubmitPlan(base, { requestedModel: "gpt-6" })).toEqual(PLAN);
  });

  it("keeps plain runs without explicit selections unchanged", () => {
    expect(
      resolvePreSubmitPlan(
        { ...base, desiredModel: "Pro", thinkingTime: undefined, researchMode: "off" },
        {},
      ),
    ).toBeNull();
  });

  it("reports a model only when the final check re-reads it", () => {
    expect(
      resolvePreSubmitPlan({ ...base, desiredModel: "Pro" }, { requestedModel: "gpt-5.5-pro" }),
    ).toMatchObject({ modelLabel: null, requestedModel: null });
    for (const modelStrategy of ["current", "ignore"] as const) {
      expect(
        resolvePreSubmitPlan({ ...base, modelStrategy }, { requestedModel: "gpt-6" }),
      ).toMatchObject({ modelLabel: null, requestedModel: null });
    }
  });

  it("always plans a check for stop-before-submit runs", () => {
    expect(
      resolvePreSubmitPlan(
        {
          ...base,
          desiredModel: "Pro",
          thinkingTime: undefined,
          researchMode: "off",
          stopBeforeSubmit: true,
        },
        {},
      ),
    ).toMatchObject({ stopBeforeSubmit: true, modelLabel: null, requestedEffort: null });
  });
});

describe("verifyComposerBeforeSubmit", () => {
  it("records the contract evidence when model, effort and the Deep Research mention match", async () => {
    const { dom, Runtime, Input, logger, logs } = setup();

    const evidence = await verifyComposerBeforeSubmit(
      Runtime,
      Input,
      PLAN,
      { attachmentCount: 0 },
      logger,
    );

    expect(evidence).toEqual({
      requestedModel: "gpt-6",
      resolvedModelLabel: "GPT-6",
      modelChecked: true,
      requestedEffort: "pro",
      effectiveEffort: "pro",
      effortFallbackReason: null,
      observedEffortIndex: 4,
      observedEffortLabel: "Pro",
      effortRangeMin: 0,
      effortRangeMax: 4,
      deepResearchRequested: true,
      deepResearchTokenPresent: true,
      attachmentCount: 0,
      verified: true,
      stoppedBeforeSubmit: false,
      mismatches: [],
      capturedAt: expect.any(String),
    });
    expect(dom.menuOpen).toBe(false);
    expect(dom.activeElement).toBe(dom.editor);
    expect(logs.join("\n")).toContain(
      'Pre-submit model read: {"view":"simple","checked":["GPT-6"]}',
    );
    expect(dom.clicks.every((label) => label === "Select ChatGPT model")).toBe(true);
  });

  it("fails when a different model row is checked", async () => {
    const { Runtime, Input, logger } = setup({ checkedModel: "GPT-5.6 Sol" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence).toMatchObject({ modelChecked: false, resolvedModelLabel: "GPT-5.6 Sol" });
    expect(evidence.mismatches[0]).toMatch(/expected "GPT-6" checked/);
  });

  it("fails on a row whose description, not title, reads GPT-6", async () => {
    const { Runtime, Input, logger } = setup({
      models: [{ label: "GPT-6 mini", descriptionSpan: "GPT-6" }, { label: "GPT-5.6 Sol" }],
      checkedModel: "GPT-6 mini",
    });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence).toMatchObject({ modelChecked: false, resolvedModelLabel: null });
    expect(evidence.mismatches[0]).toMatch(/option-not-found/);
  });

  it("fails when the effort changed after Deep Research activation", async () => {
    const { Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "3" } });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence).toMatchObject({ observedEffortIndex: 3, observedEffortLabel: "Extra High" });
    expect(evidence.mismatches).toEqual([
      expect.stringMatching(/expected pro .* observed index 3/),
    ]);
  });

  it("fails when the slider range is not the five-step range", async () => {
    const { Runtime, Input, logger } = setup({ effort: { min: "0", max: "3", value: "3" } });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence).toMatchObject({ effortRangeMin: 0, effortRangeMax: 3 });
    expect(evidence.mismatches.join(" ")).toMatch(/range 0\.\.3/);
  });

  it("fails when the effort row is locked", async () => {
    const { Runtime, Input, logger } = setup({ sliderAlwaysDisabled: true });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence.mismatches.join(" ")).toMatch(/disabled/);
  });

  it("fails when the Deep Research mention is missing", async () => {
    const { Runtime, Input, logger } = setup({ deepResearch: "none" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 1 }, logger),
    );

    expect(evidence).toMatchObject({ deepResearchTokenPresent: false, attachmentCount: 1 });
  });

  it.each([
    ["prompt-link", "not-mention-attribute"],
    ["editable-attribute", "editable-node"],
    ["arbitrary-attribute", "not-mention-attribute"],
    ["chip-child-editable", "not-mention-attribute"],
    ["mention-editable-child", "editable-node"],
  ] as const)("does not accept %s as a Deep Research mention", async (deepResearch, reason) => {
    const { Runtime, Input, logger, logs } = setup({ deepResearch });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence.deepResearchTokenPresent).toBe(false);
    const diagnostic = logs.find((line) => line.includes("Deep Research token diagnostic"));
    expect(diagnostic).toContain(`"reason":"${reason}"`);
    expect(diagnostic).toContain('"insideEditor":true');
  });

  it("accepts the mention when a typed link to the same URI is also present", async () => {
    const { Runtime, Input, logger, logs } = setup({ deepResearch: "mention-and-link" });

    await expect(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    ).resolves.toMatchObject({ deepResearchTokenPresent: true, verified: true });
    const diagnostic = logs.find((line) => line.includes("Deep Research token diagnostic"));
    expect(diagnostic).toContain('"reason":"mention"');
    expect(diagnostic).toContain('"reason":"not-mention-attribute"');
  });

  it("does not accept the token as plain prompt text", async () => {
    const { Runtime, Input, logger } = setup({
      deepResearch: "none",
      prompt: "see app://connector_openai_deep_research",
    });

    await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );
  });

  it("fails when the prompt text next to the mention is gone", async () => {
    const { Runtime, Input, logger } = setup({ prompt: "" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
    );

    expect(evidence.deepResearchTokenPresent).toBe(true);
    expect(evidence.mismatches).toEqual([expect.stringMatching(/no prompt text/)]);
  });

  it("fails when a model or effort read cannot close the picker", async () => {
    const { dom, Runtime, Input, logger } = setup({ escapeIgnored: true });

    const evidence = await withFakeTimers(() =>
      verificationFailure(
        verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
      ),
    );

    expect(evidence.mismatches.join(" ")).toMatch(/menu-not-closed/);
    expect(dom.menuOpen).toBe(true);
  });

  it("still verifies the model of a resumed conversation", async () => {
    const plan = resolvePreSubmitPlan(
      {
        desiredModel: "GPT-6",
        modelStrategy: "select",
        thinkingTime: "pro",
        researchMode: "deep",
        stopBeforeSubmit: false,
      },
      { requestedModel: "gpt-6" },
    ) as PreSubmitPlan;
    const { Runtime, Input, logger } = setup({ checkedModel: "GPT-5.6 Sol" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, Input, plan, { attachmentCount: 0 }, logger),
    );

    expect(evidence).toMatchObject({ requestedModel: "gpt-6", modelChecked: false });
  });

  it("fails when the picker menu cannot be bound", async () => {
    const { Runtime, Input, logger, logs } = setup({ unboundMenu: true });

    const evidence = await withFakeTimers(() =>
      verificationFailure(
        verifyComposerBeforeSubmit(Runtime, Input, PLAN, { attachmentCount: 0 }, logger),
      ),
    );

    expect(evidence.mismatches.join(" ")).toMatch(/menu-not-bound/);
    expect(logs.join("\n")).toContain("Pre-submit verification failed");
  });
});

describe("final check at the send boundary", () => {
  const prompt = "Research the market.";
  const SENT = new Error("sent");

  /**
   * Runtime that serves picker and composer reads from the fake DOM and scripts attachment
   * readiness and the send-button lookup, recording checks, lookups and send input in order.
   */
  function boundaryRuntime(
    dom: FakePickerDom,
    script: {
      attachmentReady?: (poll: number) => boolean;
      locate?: (lookup: number) => { status: string; x?: number; y?: number };
    },
  ) {
    const events: string[] = [];
    let attachmentPolls = 0;
    let lookups = 0;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("pickerComposerForm")) {
          if (expression.includes("MENTION_ATTRIBUTES")) events.push("check");
          return { result: { value: await dom.evaluate(expression) } };
        }
        if (expression.includes("document.readyState === 'complete'")) {
          return { result: { value: { ready: true, composer: true } } };
        }
        if (expression.includes("focusNode")) return { result: { value: { focused: true } } };
        if (expression.includes("const expected =")) {
          attachmentPolls += 1;
          const ready = script.attachmentReady?.(attachmentPolls) ?? true;
          events.push(`attachments:${ready}`);
          return { result: { value: ready } };
        }
        if (expression.includes("button.scrollIntoView")) {
          lookups += 1;
          const value = script.locate?.(lookups) ?? { status: "point", x: 5, y: 6 };
          events.push(`locate:${value.status}`);
          return { result: { value } };
        }
        return {
          result: { value: { editorText: prompt, fallbackValue: "", activeValue: prompt } },
        };
      }),
    };
    const input = {
      insertText: vi.fn(async () => undefined),
      dispatchKeyEvent: vi.fn(async ({ type }: { type: string }) => {
        events.push(`key:${type}`);
      }),
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        events.push(`mouse:${type}`);
      }),
    };
    return { runtime, input, events };
  }

  async function submitWithGate(
    dom: FakePickerDom,
    plan: PreSubmitPlan,
    script: Parameters<typeof boundaryRuntime>[1],
    attachmentNames: string[] = [],
  ) {
    const logger = (() => undefined) as unknown as BrowserLogger;
    const { runtime, input, events } = boundaryRuntime(dom, script);
    const gate = createPreSubmitGate(runtime as never, dom.cdp().Input as never, plan, logger);
    const outcome = await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        attachmentNames,
        beforeSend: gate.beforeSend({ attachmentCount: attachmentNames.length }),
        onSendInput: () => {
          events.push("send-input");
          gate.markSendInput();
        },
        onPromptSubmitted: () => {
          throw SENT;
        },
      },
      prompt,
      logger,
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return { outcome, input, events, gate };
  }

  const readyDom = (options: FakePickerOptions = {}) =>
    new FakePickerDom({
      checkedModel: "GPT-6",
      effort: { min: "0", max: "4", value: "4" },
      deepResearch: "mention",
      prompt,
      ...options,
    });

  it("checks after the attachment wait, so a change during the wait blocks the send", async () => {
    const dom = readyDom();
    const { outcome, input, events } = await submitWithGate(
      dom,
      PLAN,
      {
        attachmentReady: (poll) => {
          if (poll === 2) dom.slider?.setAttribute("aria-valuenow", "3");
          return poll >= 3;
        },
      },
      ["report.pdf"],
    );

    const evidence = await verificationFailure(
      Promise.reject((outcome as { error: unknown }).error),
    );
    expect(evidence).toMatchObject({ verified: false, observedEffortIndex: 3 });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(events).not.toContain("send-input");
  });

  it("checks after the button is ready and clicks right after a fresh lookup", async () => {
    const { outcome, events } = await submitWithGate(readyDom(), PLAN, {}, ["report.pdf"]);

    expect(outcome).toEqual({ error: SENT });
    expect(events).toEqual([
      "attachments:true",
      "locate:point",
      "check",
      "attachments:true",
      "locate:point",
      "send-input",
      "mouse:mouseMoved",
      "mouse:mousePressed",
      "mouse:mouseReleased",
    ]);
  });

  it("runs the check again when the button disappears after a check", async () => {
    const { outcome, events } = await submitWithGate(readyDom(), PLAN, {
      locate: (lookup) => (lookup === 2 ? { status: "missing" } : { status: "point", x: 5, y: 6 }),
    });

    expect(outcome).toEqual({ error: SENT });
    expect(events.filter((event) => event === "check")).toHaveLength(2);
    expect(events.indexOf("mouse:mousePressed")).toBeGreaterThan(events.lastIndexOf("check"));
  });

  it("stops at the send boundary once the button is ready", async () => {
    const { outcome, input, events, gate } = await submitWithGate(
      readyDom(),
      { ...PLAN, stopBeforeSubmit: true },
      {},
    );

    expect(outcome).toEqual({ value: null });
    expect(gate.stopped).toBe(true);
    expect(events).toEqual(["locate:point", "check"]);
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  it("checks right before the Enter fallback and never presses Enter on a mismatch", async () => {
    const mismatch = await submitWithGate(readyDom({ checkedModel: "GPT-5.6 Sol" }), PLAN, {
      locate: () => ({ status: "missing" }),
    });
    await verificationFailure(Promise.reject((mismatch.outcome as { error: unknown }).error));
    expect(mismatch.input.dispatchKeyEvent).not.toHaveBeenCalled();

    const passing = await submitWithGate(readyDom(), PLAN, {
      locate: () => ({ status: "missing" }),
    });
    expect(passing.outcome).toEqual({ error: SENT });
    expect(passing.events.slice(-4)).toEqual(["check", "send-input", "key:keyDown", "key:keyUp"]);
  });
});

describe("pre-submit gate state", () => {
  it("verifies a Pro request at Extra High after the effort owner reported Pro unavailable", async () => {
    const { dom, Runtime, Input, logger, logs } = setup({
      effort: { min: "0", max: "4", value: "1" },
      keyCeiling: 3,
    });
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);

    const decision = await withFakeTimers(async () => {
      const effort = await gate.guardSelection("thinking-time", 0, () =>
        ensureThinkingTime(Runtime, Input, "pro", logger),
      );
      gate.recordEffortSelection(effort);
      return gate.beforeSend({ attachmentCount: 0 })();
    });

    expect(decision).toBe("send");
    expect(gate.evidence).toMatchObject({
      requestedEffort: "pro",
      effectiveEffort: "extra-high",
      effortFallbackReason: "pro-step-locked",
      observedEffortIndex: 3,
      observedEffortLabel: "Extra High",
      verified: true,
      mismatches: [],
    });
    expect(dom.sliderValue).toBe(3);
    expect(logs.join("\n")).toContain('"effortFallback":"pro -> extra-high (pro-step-locked)"');
  });

  it("fails a missing-Pro-step fallback when the final read offers Pro again", async () => {
    const { Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "3" } });
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);
    gate.recordEffortSelection({
      level: "extra-high",
      index: 3,
      label: "Extra High",
      status: "switched",
      requestedLevel: "pro",
      fallback: { from: "pro", reason: "pro-step-absent" },
    });

    const evidence = await verificationFailure(gate.beforeSend({ attachmentCount: 0 })());

    expect(evidence.mismatches.join(" ")).toContain("Pro step is offered again (range 0..4)");
  });
  it("still fails a Pro request whose slider sits at Extra High without a reported fallback", async () => {
    const { Runtime, Input, logger } = setup({ effort: { min: "0", max: "4", value: "3" } });
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);

    const evidence = await verificationFailure(gate.beforeSend({ attachmentCount: 0 })());

    expect(evidence).toMatchObject({ effectiveEffort: "pro", effortFallbackReason: null });
    expect(evidence.mismatches.join(" ")).toContain("expected pro (Pro), observed index 3");
  });
  it("hands passing evidence to onVerified before the send decision is returned", async () => {
    const { Runtime, Input, logger } = setup();
    const order: string[] = [];
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger, {
      onVerified: (evidence) => order.push(`verified:${evidence.verified}`),
    });

    const decision = await gate.beforeSend({ attachmentCount: 0 })();
    order.push(`decision:${decision}`);

    expect(order).toEqual(["verified:true", "decision:send"]);
  });

  it("does not report evidence through onVerified when the final check fails", async () => {
    const { Runtime, Input, logger } = setup({ checkedModel: "GPT-5.6 Sol" });
    const onVerified = vi.fn();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger, { onVerified });

    await verificationFailure(gate.beforeSend({ attachmentCount: 0 })());

    expect(onVerified).not.toHaveBeenCalled();
  });

  it("keeps a re-check before any send input an unsent failure with evidence", async () => {
    const { dom, Runtime, Input, logger } = setup();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);
    const hook = gate.beforeSend({ attachmentCount: 0 });
    await expect(hook()).resolves.toBe("send");
    dom.setChecked("GPT-5.6 Sol");

    const evidence = await verificationFailure(hook());

    expect(evidence.modelChecked).toBe(false);
  });

  it("after send input, the same hook neither claims nothing was sent nor replaces the evidence", async () => {
    const { dom, Runtime, Input, logger } = setup();
    const onVerified = vi.fn();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger, { onVerified });
    const hook = gate.beforeSend({ attachmentCount: 0 });
    await expect(hook()).resolves.toBe("send");
    const firstEvidence = gate.evidence;
    gate.markSendInput();
    dom.setChecked("GPT-5.6 Sol");

    const error = await hook().then(
      () => {
        throw new Error("expected the later check to fail");
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BrowserAutomationError);
    const failure = error as BrowserAutomationError;
    expect(failure.message).not.toMatch(/nothing was sent/i);
    expect(failure.message).toMatch(/send input for an earlier prompt/);
    expect(failure.details).toMatchObject({ stage: "later-submission-verification" });
    expect(failure.details).not.toHaveProperty("preSubmitVerification");
    expect(gate.evidence).toBe(firstEvidence);
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it("checks a follow-up with a new hook the same way once send input went out", async () => {
    const { dom, Runtime, Input, logger } = setup();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);
    await gate.beforeSend({ attachmentCount: 0 })();
    gate.markSendInput();
    dom.setChecked("GPT-5.6 Sol");

    await expect(gate.beforeSend({ attachmentCount: 0 })()).rejects.toMatchObject({
      details: { stage: "later-submission-verification" },
    });
  });
});

describe("selection failures before send", () => {
  /** Selection errors keep the owner's stage; the evidence rides along in the details. */
  function selectionEvidence(error: unknown): BrowserPreSubmitVerification {
    expect(error).toBeInstanceOf(BrowserAutomationError);
    const evidence = (
      (error as BrowserAutomationError).details as {
        preSubmitVerification?: BrowserPreSubmitVerification;
      }
    ).preSubmitVerification;
    expect(evidence?.verified).toBe(false);
    return evidence as BrowserPreSubmitVerification;
  }

  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected the selection owner to fail");
      },
      (error: unknown) => error,
    );

  it("records a model selection failure after retries", async () => {
    const { Runtime, Input, logger, logs } = setup();
    const gate = createPreSubmitGate(Runtime, Input, { ...PLAN, stopBeforeSubmit: true }, logger);
    let attempts = 0;

    const error = await caught(
      gate.guardSelection("model-selection", 0, () =>
        withRetries(
          async () => {
            attempts += 1;
            throw new Error('Model picker: option not found for exact model label "GPT-6"');
          },
          { retries: 2, delayMs: 0 },
        ),
      ),
    );

    expect(attempts).toBe(3);
    const evidence = selectionEvidence(error);
    expect(evidence).toMatchObject({
      requestedModel: "gpt-6",
      resolvedModelLabel: null,
      modelChecked: false,
      observedEffortIndex: null,
      deepResearchTokenPresent: false,
      attachmentCount: 0,
      stoppedBeforeSubmit: true,
    });
    expect(evidence.mismatches[0]).toMatch(
      /^model-selection: failed: Model picker: option not found/,
    );
    expect(logs.filter((line) => line.includes("Pre-submit verification failed"))).toHaveLength(1);
  });

  it("records the slider an effort selection failure actually read", async () => {
    const { Runtime, Input, logger } = setup({ effort: { min: "0", max: "2", value: "2" } });
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);

    const error = await caught(
      gate.guardSelection("thinking-time", 0, () =>
        ensureThinkingTime(Runtime, Input, "pro", logger),
      ),
    );

    expect(selectionEvidence(error)).toMatchObject({
      requestedEffort: "pro",
      observedEffortIndex: 2,
      observedEffortLabel: "High",
      effortRangeMin: 0,
      effortRangeMax: 2,
    });
  });

  it("records a Deep Research activation failure with the uploaded attachment count", async () => {
    const { dom, Runtime, Input, logger } = setup({
      deepResearch: "none",
      deepResearchOffered: false,
    });
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);

    const error = await withFakeTimers(() =>
      caught(
        gate.guardSelection("deep-research-activation", 2, () =>
          activateDeepResearch(Runtime, Input, logger),
        ),
      ),
    );

    const evidence = selectionEvidence(error);
    expect(evidence).toMatchObject({ deepResearchRequested: true, attachmentCount: 2 });
    expect(evidence.mismatches[0]).toMatch(/^deep-research-activation: dropdown-item-missing: /);
    expect(dom.clicks).toEqual(["Add files and more"]);
  });

  it("adds no evidence once send input went out", async () => {
    const { Runtime, Input, logger } = setup();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger);
    gate.markSendInput();
    const original = new BrowserAutomationError("Deep Research mention did not appear", {
      stage: "deep-research-activate",
    });

    const error = await caught(
      gate.guardSelection("deep-research-activation", 0, async () => {
        throw original;
      }),
    );

    expect(error).toBe(original);
    expect(original.details).not.toHaveProperty("preSubmitVerification");
  });

  it("passes transport failures through unchanged", async () => {
    const { Runtime, Input, logger } = setup();
    const gate = createPreSubmitGate(Runtime, Input, PLAN, logger, {
      isTransportFailure: (error) =>
        error instanceof Error && error.message === "WebSocket is closed",
    });
    const original = new Error("WebSocket is closed");

    await expect(
      gate.guardSelection("thinking-time", 0, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("runs owners directly when the run has no pre-submit plan", async () => {
    const original = new Error("legacy picker failed");

    await expect(
      guardPreSendSelection(null, "model-selection", 0, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});

describe("activateDeepResearch on the observed composer", () => {
  it("opens Add files and more, clicks Deep research and confirms the inline mention", async () => {
    const { dom, Runtime, Input, logger, logs } = setup({ deepResearch: "none", prompt: "" });

    await activateDeepResearch(Runtime, Input, logger);

    expect(dom.clicks).toEqual(["Add files and more", "Deep research"]);
    expect(dom.mentionPresent()).toBe(true);
    expect(dom.listOpen).toBe(false);
    expect(logs).toContain("Deep Research mode activated (add-context list)");
  });

  it("does nothing when the mention is already in the composer", async () => {
    const { dom, Runtime, Input, logger, logs } = setup();

    await activateDeepResearch(Runtime, Input, logger);

    expect(dom.clicks).toEqual([]);
    expect(logs).toContain("Deep Research mode already active (composer mention)");
  });
});

describe("clearComposerAfterStop", () => {
  it("removes a leftover mention with select-all and Backspace, never Enter", async () => {
    const dom = new FakePickerDom({ deepResearch: "mention", prompt: "draft" });
    const { Input } = dom.cdp();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) =>
        expression.includes("MENTION_ATTRIBUTES")
          ? { result: { value: await dom.evaluate(expression) } }
          : { result: { value: { cleared: true, remaining: [] } } },
      ),
    };
    const logger = Object.assign(vi.fn(), { verbose: false }) as unknown as BrowserLogger;

    const warnings = await clearComposerAfterStop(runtime as never, Input as never, logger, {
      attachmentCount: 0,
    });

    expect(warnings).toEqual([]);
    expect(dom.mentionPresent()).toBe(false);
    expect(dom.sentKeys).toEqual(["a+2", "Backspace"]);
  });

  it("reports cleanup problems as warnings without throwing", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("MENTION_ATTRIBUTES")) {
          return {
            result: {
              value: {
                composerFound: true,
                present: true,
                bodyTextLength: 0,
                occurrences: [{ tag: "span", accepted: true, reason: "mention" }],
              },
            },
          };
        }
        return { result: { value: { cleared: false, remaining: ["draft"] } } };
      }),
    };
    const input = { dispatchKeyEvent: vi.fn(async () => undefined) };
    const logger = Object.assign(vi.fn(), { verbose: false }) as unknown as BrowserLogger;

    const warnings = await clearComposerAfterStop(runtime as never, input as never, logger, {
      attachmentCount: 0,
    });

    expect(warnings.map((warning) => warning.code)).toEqual([
      "stop-cleanup-prompt",
      "stop-cleanup-deep-research",
    ]);
    expect(input.dispatchKeyEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter" }),
    );
  });
});
