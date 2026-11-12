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

function setup(options: FakePickerOptions = {}) {
  const dom = new FakePickerDom({
    checkedModel: "GPT-6",
    effort: { min: "0", max: "4", value: "4" },
    deepResearchToken: "attribute",
    prompt: "Research the market.",
    ...options,
  });
  const logs: string[] = [];
  const logger = ((message: string) => logs.push(message)) as BrowserLogger;
  return { dom, Runtime: dom.cdp().Runtime as never, logger, logs };
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

  it("verifies exact submenu models, effort and Deep Research", () => {
    expect(
      resolvePreSubmitPlan(base, { requestedModel: "gpt-6", resumingConversation: false }),
    ).toEqual(PLAN);
  });

  it("keeps plain runs without explicit selections unchanged", () => {
    expect(
      resolvePreSubmitPlan(
        { ...base, desiredModel: "Pro", thinkingTime: undefined, researchMode: "off" },
        { resumingConversation: false },
      ),
    ).toBeNull();
  });

  it("does not verify models outside the current submenu or skipped pickers", () => {
    expect(
      resolvePreSubmitPlan({ ...base, desiredModel: "Pro" }, { resumingConversation: false })
        ?.modelLabel,
    ).toBeNull();
    expect(
      resolvePreSubmitPlan({ ...base, modelStrategy: "current" }, { resumingConversation: false })
        ?.modelLabel,
    ).toBeNull();
    expect(resolvePreSubmitPlan(base, { resumingConversation: true })?.modelLabel).toBeNull();
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
        { resumingConversation: false },
      ),
    ).toMatchObject({ stopBeforeSubmit: true, modelLabel: null, requestedEffort: null });
  });
});

describe("verifyComposerBeforeSubmit", () => {
  it("records the contract evidence when model, effort and the DR token all match", async () => {
    const { dom, Runtime, logger } = setup();

    const evidence = await verifyComposerBeforeSubmit(
      Runtime,
      PLAN,
      { attachmentCount: 0, prompt: "Research the market." },
      logger,
    );

    expect(evidence).toEqual({
      requestedModel: "gpt-6",
      resolvedModelLabel: "GPT-6",
      modelChecked: true,
      requestedEffort: "pro",
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
  });

  it("fails when a different model row is checked", async () => {
    const { Runtime, logger } = setup({ checkedModel: "GPT-5.6 Sol" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 0, prompt: "x" }, logger),
    );

    expect(evidence).toMatchObject({ modelChecked: false, resolvedModelLabel: "GPT-5.6 Sol" });
    expect(evidence.mismatches[0]).toMatch(/expected "GPT-6" checked/);
  });

  it("fails when the effort changed after Deep Research activation", async () => {
    const { Runtime, logger } = setup({ effort: { min: "0", max: "4", value: "3" } });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 0, prompt: "x" }, logger),
    );

    expect(evidence).toMatchObject({ observedEffortIndex: 3, observedEffortLabel: "Extra High" });
    expect(evidence.mismatches).toEqual([
      expect.stringMatching(/expected pro .* observed index 3/),
    ]);
  });

  it("fails when the slider range is not the five-step range", async () => {
    const { Runtime, logger } = setup({ effort: { min: "0", max: "3", value: "3" } });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 0, prompt: "x" }, logger),
    );

    expect(evidence).toMatchObject({ effortRangeMin: 0, effortRangeMax: 3 });
    expect(evidence.mismatches.join(" ")).toMatch(/range 0\.\.3/);
  });

  it("fails when the slider is locked", async () => {
    const { Runtime, logger } = setup({ sliderAlwaysDisabled: true });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 0, prompt: "x" }, logger),
    );

    expect(evidence.mismatches.join(" ")).toMatch(/disabled/);
  });

  it("fails when the Deep Research token left the composer", async () => {
    const { Runtime, logger } = setup({ deepResearchToken: "none" });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 1, prompt: "x" }, logger),
    );

    expect(evidence).toMatchObject({ deepResearchTokenPresent: false, attachmentCount: 1 });
  });

  it("counts a non-editable token chip but not the same text typed in the prompt", async () => {
    const chip = setup({ deepResearchToken: "chip" });
    await expect(
      verifyComposerBeforeSubmit(
        chip.Runtime,
        PLAN,
        { attachmentCount: 0, prompt: "x" },
        chip.logger,
      ),
    ).resolves.toMatchObject({ deepResearchTokenPresent: true });

    const typed = "see app://connector_openai_deep_research";
    const promptOnly = setup({ deepResearchToken: "none", prompt: typed });
    await verificationFailure(
      verifyComposerBeforeSubmit(
        promptOnly.Runtime,
        PLAN,
        { attachmentCount: 0, prompt: typed },
        promptOnly.logger,
      ),
    );
  });

  it("fails when the picker menu cannot be bound", async () => {
    const { Runtime, logger, logs } = setup({ unboundMenu: true });

    const evidence = await verificationFailure(
      verifyComposerBeforeSubmit(Runtime, PLAN, { attachmentCount: 0, prompt: "x" }, logger),
    );

    expect(evidence.mismatches.join(" ")).toMatch(/menu-not-bound/);
    expect(logs.join("\n")).toContain("Pre-submit verification failed");
  });
});

describe("submitPrompt with the pre-submit gate", () => {
  const prompt = "Research the market.";

  function composerRuntime(dom: FakePickerDom) {
    const afterHook: string[] = [];
    let hookStarted = false;
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("pickerComposerForm")) {
          hookStarted = true;
          return { result: { value: await dom.evaluate(expression) } };
        }
        if (hookStarted) afterHook.push(expression);
        if (expression.includes("document.readyState === 'complete'")) {
          return { result: { value: { ready: true, composer: true } } };
        }
        if (expression.includes("focusNode")) return { result: { value: { focused: true } } };
        return {
          result: { value: { editorText: prompt, fallbackValue: "", activeValue: prompt } },
        };
      }),
    };
    const input = {
      insertText: vi.fn(async () => undefined),
      dispatchKeyEvent: vi.fn(async () => undefined),
    };
    return { runtime, input, afterHook };
  }

  it("stops after a verified check without any send action", async () => {
    const { dom, logger } = setup();
    const { runtime, input, afterHook } = composerRuntime(dom);
    const gate = createPreSubmitGate(runtime as never, { ...PLAN, stopBeforeSubmit: true }, logger);
    const onPromptSubmitted = vi.fn();

    const result = await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        onPromptSubmitted,
        beforeSend: gate.beforeSend({ attachmentCount: 0, prompt }),
      },
      prompt,
      logger,
    );

    expect(result).toBeNull();
    expect(gate.stopped).toBe(true);
    expect(gate.evidence).toMatchObject({ verified: true, stoppedBeforeSubmit: true });
    expect(input.insertText).toHaveBeenCalledTimes(1);
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(onPromptSubmitted).not.toHaveBeenCalled();
    expect(afterHook).toEqual([]);
  });

  it("refuses to send when the final check fails", async () => {
    const { dom, logger } = setup({ checkedModel: "GPT-5.6 Sol" });
    const { runtime, input, afterHook } = composerRuntime(dom);
    const gate = createPreSubmitGate(runtime as never, PLAN, logger);
    const onPromptSubmitted = vi.fn();

    await verificationFailure(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          onPromptSubmitted,
          beforeSend: gate.beforeSend({ attachmentCount: 0, prompt }),
        },
        prompt,
        logger,
      ),
    );

    expect(gate.stopped).toBe(false);
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(onPromptSubmitted).not.toHaveBeenCalled();
    expect(afterHook).toEqual([]);
  });

  it("hands passing evidence to onVerified before the send decision is returned", async () => {
    const { dom, logger } = setup();
    const order: string[] = [];
    const gate = createPreSubmitGate(dom.cdp().Runtime as never, PLAN, logger, {
      onVerified: (evidence) => order.push(`verified:${evidence.verified}`),
    });

    const decision = await gate.beforeSend({ attachmentCount: 0, prompt })();
    order.push(`decision:${decision}`);

    expect(order).toEqual(["verified:true", "decision:send"]);
  });

  it("does not report evidence through onVerified when the final check fails", async () => {
    const { dom, logger } = setup({ checkedModel: "GPT-5.6 Sol" });
    const onVerified = vi.fn();
    const gate = createPreSubmitGate(dom.cdp().Runtime as never, PLAN, logger, { onVerified });

    await verificationFailure(gate.beforeSend({ attachmentCount: 0, prompt })());

    expect(onVerified).not.toHaveBeenCalled();
  });

  it("lets a verified normal run continue to the send step", async () => {
    const { dom, logger } = setup();
    const gate = createPreSubmitGate(dom.cdp().Runtime as never, PLAN, logger);

    await expect(gate.beforeSend({ attachmentCount: 0, prompt })()).resolves.toBe("send");
    expect(gate.stopped).toBe(false);
    expect(gate.evidence?.verified).toBe(true);
  });
});

describe("clearComposerAfterStop", () => {
  it("reports cleanup problems as warnings without throwing", async () => {
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("TOKEN")) {
          return {
            result: {
              value: {
                composerFound: true,
                present: true,
                locations: ["span[data-href]"],
                outsideComposer: 0,
              },
            },
          };
        }
        return { result: { value: { cleared: false, remaining: ["draft"] } } };
      }),
    };
    const logger = Object.assign(vi.fn(), { verbose: false }) as unknown as BrowserLogger;

    const warnings = await clearComposerAfterStop(runtime as never, logger, {
      attachmentCount: 0,
      prompt: "draft",
    });

    expect(warnings.map((warning) => warning.code)).toEqual([
      "stop-cleanup-prompt",
      "stop-cleanup-deep-research",
    ]);
  });
});

describe("selection failures before send", () => {
  const prompt = "Research the market.";

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

  /** Mirrors the browser run order: selection owners, then submitPrompt with the gate hook. */
  async function runSelectionThenSubmit(
    gate: ReturnType<typeof createPreSubmitGate>,
    stage: "model-selection" | "thinking-time" | "deep-research-activation",
    attachmentCount: number,
    owner: () => Promise<unknown>,
  ) {
    const input = {
      insertText: vi.fn(async () => undefined),
      dispatchKeyEvent: vi.fn(async () => undefined),
    };
    const submitRuntime = { evaluate: vi.fn() };
    const error = await gate
      .guardSelection(stage, attachmentCount, owner)
      .then(() =>
        submitPrompt(
          {
            runtime: submitRuntime as never,
            input: input as never,
            beforeSend: gate.beforeSend({ attachmentCount, prompt }),
          },
          prompt,
          (() => undefined) as unknown as BrowserLogger,
        ),
      )
      .then(
        () => {
          throw new Error("expected the selection owner to fail");
        },
        (caught: unknown) => caught,
      );
    return { error, input, submitRuntime };
  }

  it("records a model selection failure after retries without reaching send", async () => {
    const { Runtime, logger, logs } = setup();
    const gate = createPreSubmitGate(Runtime, { ...PLAN, stopBeforeSubmit: true }, logger);
    let attempts = 0;

    const { error, input, submitRuntime } = await runSelectionThenSubmit(
      gate,
      "model-selection",
      0,
      () =>
        withRetries(
          async () => {
            attempts += 1;
            throw new Error('Model picker: option not found for exact model label "GPT-6"');
          },
          { retries: 2, delayMs: 0 },
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
    expect((error as BrowserAutomationError).details).toMatchObject({
      stage: "model-selection",
      selectionStage: "model-selection",
    });
    expect(logs.filter((line) => line.includes("Pre-submit verification failed"))).toHaveLength(1);
    expect(input.insertText).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(submitRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("records the slider an effort selection failure actually read", async () => {
    const dom = new FakePickerDom({ effort: { min: "0", max: "3", value: "3" } });
    const { Runtime, Input } = dom.cdp();
    const { logger } = setup();
    const gate = createPreSubmitGate(Runtime as never, PLAN, logger);

    const { error, input } = await runSelectionThenSubmit(gate, "thinking-time", 0, () =>
      ensureThinkingTime(Runtime as never, Input as never, "pro", logger),
    );

    const evidence = selectionEvidence(error);
    expect(evidence).toMatchObject({
      requestedEffort: "pro",
      observedEffortIndex: 3,
      observedEffortLabel: "Extra High",
      effortRangeMin: 0,
      effortRangeMax: 3,
      stoppedBeforeSubmit: false,
    });
    expect(evidence.mismatches[0]).toMatch(/^thinking-time: effort-range-invalid: /);
    expect((error as BrowserAutomationError).details).toMatchObject({ stage: "thinking-time" });
    expect(dom.sentKeys).toEqual([]);
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  it("records a Deep Research activation failure with the uploaded attachment count", async () => {
    const { logger } = setup();
    const gate = createPreSubmitGate(setup().Runtime, PLAN, logger);
    const drRuntime = {
      evaluate: vi.fn(async () => ({ result: { value: { status: "plus-button-missing" } } })),
    };

    const { error, input } = await runSelectionThenSubmit(gate, "deep-research-activation", 2, () =>
      activateDeepResearch(drRuntime as never, {} as never, logger),
    );

    const evidence = selectionEvidence(error);
    expect(evidence).toMatchObject({ deepResearchRequested: true, attachmentCount: 2 });
    expect(evidence.mismatches[0]).toMatch(/^deep-research-activation: plus-button-missing: /);
    expect((error as BrowserAutomationError).details).toMatchObject({
      stage: "deep-research-activate",
      code: "plus-button-missing",
    });
    expect(input.insertText).not.toHaveBeenCalled();
  });

  it("adds no evidence once the gate has decided to send", async () => {
    const { Runtime, logger } = setup();
    const gate = createPreSubmitGate(Runtime, PLAN, logger);
    await expect(gate.beforeSend({ attachmentCount: 0, prompt })()).resolves.toBe("send");
    const original = new BrowserAutomationError("Deep Research pill did not appear", {
      stage: "deep-research-activate",
    });

    const error = await gate
      .guardSelection("deep-research-activation", 0, async () => {
        throw original;
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(original);
    expect(original.details).not.toHaveProperty("preSubmitVerification");
  });

  it("passes transport failures through unchanged", async () => {
    const { Runtime, logger } = setup();
    const gate = createPreSubmitGate(Runtime, PLAN, logger, {
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
