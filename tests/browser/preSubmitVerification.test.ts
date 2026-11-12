import { describe, expect, it, vi } from "vitest";
import {
  clearComposerAfterStop,
  createPreSubmitGate,
  resolvePreSubmitPlan,
  verifyComposerBeforeSubmit,
  type PreSubmitPlan,
} from "../../src/browser/actions/preSubmitVerification.js";
import { submitPrompt } from "../../src/browser/actions/promptComposer.js";
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
