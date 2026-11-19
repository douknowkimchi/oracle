import { existsSync } from "node:fs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  buildConversationTurnListExpression,
  buildConversationTurnRoleFunction,
} from "../../src/browser/conversationTurns.js";
import { __test__ as promptComposer } from "../../src/browser/actions/promptComposer.js";
import { readAssistantSnapshot } from "../../src/browser/actions/assistantResponse.js";
import { buildUserTurnAttachmentExpressionForTest } from "../../src/browser/actions/attachments.js";
import {
  buildDeepResearchCompletionPollExpressionForTest,
  buildDeepResearchStatusExpressionForTest,
} from "../../src/browser/actions/deepResearch.js";
import { buildTabInspectionExpressionForTest } from "../../src/browser/liveTabs.js";
import { __test__ as reattach } from "../../src/browser/reattach.js";
import type { ChromeClient } from "../../src/browser/types.js";

// These expressions run inside ChatGPT, so they are checked against real DOM in a real browser.
// Set ORACLE_DOM_TEST_CHROME to a Chrome / chrome-headless-shell binary when none is installed
// at a standard location.
const chromePath = [
  process.env.ORACLE_DOM_TEST_CHROME,
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

const PROMPT =
  "Hospital name: Songpa Clinic. Official address: 236 Dongnam-ro. How do patients find it?";

const legacyTurn = (index: number, role: string, text: string) =>
  `<article data-testid="conversation-turn-${index}" data-turn="${role}">` +
  `<div data-message-author-role="${role}"><div class="whitespace-pre-wrap">${text}</div></div></article>`;

// Modelled on the live ChatGPT transcript observed 2026-11-20: one turn wrapper holds the user
// unit, the Deep Research app body (no unit key) and the final assistant unit; the action bar is
// outside every unit.
const currentTurn = (turn: string, prompt: string, answer: string | null) => `
  <div data-turn-key="${turn}-u"><div data-content-search-turn-key="${turn}">
    <div data-talvt-turn-state="complete">
      <h4 data-conversation-role="user">You said:</h4>
      <div data-chatgpt-search-unit-key="${turn}:0:user" class="group/user-message">
        <div data-content-search-unit-key="${turn}:0:user">
          <div data-user-message-bubble="true">Deep research ${prompt}
            <div aria-label="report.pdf file">report.pdf</div>
          </div>
        </div>
      </div>
      <span data-chatgpt-agent-turn-start=""></span>
      <div data-response-body="${turn}-app"><div data-mcp-app-frame="true">
        <iframe title="Deep research" src="about:blank" style="width:600px;height:400px"></iframe>
      </div></div>
      ${
        answer === null
          ? ""
          : `<div data-chatgpt-search-unit-key="${turn}:3:assistant">
        <h4 data-conversation-role="assistant">ChatGPT said:</h4>
        <div data-response-body="${turn}-final"><div>${answer}</div></div>
      </div>`
      }
      <div><button aria-label="Copy">c</button><button aria-label="Share">s</button></div>
    </div>
  </div></div>`;

function runtimeFor(page: Page): ChromeClient["Runtime"] {
  return {
    evaluate: async ({ expression }: { expression: string }) => ({
      result: { value: await page.evaluate(expression) },
    }),
  } as unknown as ChromeClient["Runtime"];
}

describe.skipIf(!chromePath)("conversation turns in a real browser", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      void (request.url().startsWith("about:") ? request.continue() : request.abort());
    });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  const show = (body: string) => page.setContent(`<html><body><main>${body}</main></body></html>`);
  const turns = () =>
    page.evaluate(`(() => {
      const role = ${buildConversationTurnRoleFunction()};
      return (${buildConversationTurnListExpression()}).map((node) =>
        role(node) + ':' + (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 24));
    })()`) as Promise<string[]>;
  const appendLater = (html: string, ms = 150) =>
    page.evaluate(
      (markup, wait) => {
        setTimeout(
          () => document.querySelector("main")?.insertAdjacentHTML("beforeend", markup),
          wait,
        );
      },
      html,
      ms,
    );

  describe("message list and roles", () => {
    test("legacy turn containers count once with their nested role nodes", async () => {
      await show(legacyTurn(1, "user", "old prompt") + legacyTurn(2, "assistant", "old answer"));
      expect(await turns()).toEqual(["user:old prompt", "assistant:old answer"]);
    });

    test("legacy response extraction indexes the top-level turn, not its nested role node", async () => {
      await show(legacyTurn(1, "user", "old prompt") + legacyTurn(2, "assistant", "old answer"));
      const snapshot = await readAssistantSnapshot(runtimeFor(page), 0);
      expect(snapshot).toMatchObject({ text: "old answer", turnIndex: 1 });
    });

    test("current markup yields user, app body and final answer in DOM order", async () => {
      await show(currentTurn("t1", PROMPT, "Final summary of the report"));
      const listed = await turns();
      expect(listed.map((entry) => entry.split(":")[0])).toEqual([
        "user",
        "assistant",
        "assistant",
      ]);
      expect(listed[0]).toContain("Deep research Hospital");
      expect(listed[2]).toContain("ChatGPT said");
    });

    test("legacy role nodes and current units mixed as siblings keep DOM order", async () => {
      await show(
        '<div data-message-author-role="user">legacy prompt</div>' +
          '<div data-message-author-role="assistant">legacy answer</div>' +
          currentTurn("t2", PROMPT, "new answer"),
      );
      expect((await turns()).map((entry) => entry.split(":")[0])).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "assistant",
      ]);
    });

    test("a legacy container around a current unit counts the message once", async () => {
      await show(
        '<article data-testid="conversation-turn-1"><div data-chatgpt-search-unit-key="t:0:user">' +
          '<div data-message-author-role="user">nested prompt</div></div></article>' +
          '<article data-testid="conversation-turn-2"><div data-chatgpt-search-unit-key="t:1:assistant">' +
          '<div data-response-body="x">nested answer</div></div></article>',
      );
      expect(await turns()).toEqual(["user:nested prompt", "assistant:nested answer"]);
    });

    test("a wrapper holding messages of different roles is split into them", async () => {
      await show(
        '<div data-testid="conversation-turn-1">' +
          '<div data-chatgpt-search-unit-key="t:0:user">wrapped prompt</div>' +
          '<div data-chatgpt-search-unit-key="t:1:assistant">wrapped answer</div></div>',
      );
      expect(await turns()).toEqual(["user:wrapped prompt", "assistant:wrapped answer"]);
    });
  });

  describe("submit confirmation", () => {
    const verify = (baseline?: number, timeoutMs = 1_500) =>
      promptComposer.verifyPromptCommitted(
        runtimeFor(page),
        PROMPT,
        timeoutMs,
        undefined,
        baseline,
      );

    beforeEach(async () => {
      await show("");
    });

    test("confirms the new current-markup user message after the baseline", async () => {
      await appendLater(currentTurn("t1", PROMPT, null));
      await expect(verify()).resolves.toBe(1);
    });

    test("confirms a new legacy user turn after earlier turns", async () => {
      await show(legacyTurn(1, "user", "first") + legacyTurn(2, "assistant", "reply"));
      await appendLater(legacyTurn(3, "user", PROMPT));
      await expect(verify(2)).resolves.toBe(3);
    });

    test("an identical earlier prompt and an assistant echo never confirm a send", async () => {
      await show(currentTurn("t1", PROMPT, "answer"));
      await appendLater(
        `<div data-chatgpt-search-unit-key="t9:1:assistant"><div data-response-body="e">${PROMPT}</div></div>`,
      );
      const error = await verify(3, 800).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        details: {
          code: "prompt-commit-timeout",
          commitProbe: {
            baseline: 3,
            newUserTurns: 0,
            matchedUserIndex: -1,
            priorUserMatched: true,
            assistantEchoMatched: true,
          },
        },
      });
    });

    test("a new user message with other text does not confirm this prompt", async () => {
      await appendLater(currentTurn("t1", "an unrelated question entirely", null));
      const error = await verify(undefined, 800).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        details: {
          code: "prompt-commit-timeout",
          commitProbe: { newUserTurns: 1, matchedUserIndex: -1 },
        },
      });
    });
  });

  describe("consumers agree on role and turn index", () => {
    beforeEach(async () => {
      await show(currentTurn("t1", PROMPT, "Final summary of the completed research report."));
    });

    test("reattach finds the user prompt at the user's index", async () => {
      await expect(reattach.readPromptPreviewTurnIndex(runtimeFor(page), PROMPT)).resolves.toBe(0);
    });

    test("attachment verification reads the sent user message at the same index", async () => {
      const result = (await page.evaluate(
        buildUserTurnAttachmentExpressionForTest({
          minTurnIndex: 0,
          expectedPromptPrefix: PROMPT.toLowerCase(),
        }),
      )) as { ok: boolean; turnIndex: number; promptMatches: boolean; hasAttachmentUi: boolean };
      expect(result).toMatchObject({
        ok: true,
        turnIndex: 0,
        promptMatches: true,
        hasAttachmentUi: true,
      });
    });

    test("response extraction returns the final assistant message after the user turn", async () => {
      const snapshot = await readAssistantSnapshot(runtimeFor(page), 0);
      expect(snapshot?.text).toBe("Final summary of the completed research report.");
      expect(snapshot?.turnIndex).toBe(2);
    });

    test("tab inspection links the latest user and assistant messages", async () => {
      const tab = (await page.evaluate(buildTabInspectionExpressionForTest())) as Record<
        string,
        unknown
      >;
      expect(tab).toMatchObject({
        assistantFollowsLatestUser: true,
        lastUserTurnIndex: 0,
        lastAssistantTurnIndex: 2,
      });
    });
  });

  describe("Deep Research page reads", () => {
    test("a running report titled Deep research in the new turn is active research", async () => {
      await show(currentTurn("t1", PROMPT, null));
      const poll = (await page.evaluate(
        buildDeepResearchCompletionPollExpressionForTest(0),
      )) as Record<string, unknown>;
      expect(poll).toMatchObject({ finished: false, hasActiveScopedResearch: true });
    });

    test("a tool-only placeholder is not reported completed", async () => {
      await show(
        '<div data-message-author-role="assistant">Called tool' +
          '<button data-testid="copy-turn-action-button"></button></div>',
      );
      const status = (await page.evaluate(buildDeepResearchStatusExpressionForTest())) as Record<
        string,
        unknown
      >;
      expect(status).toMatchObject({
        completed: false,
        placeholderOnly: true,
        textLength: "Called tool".length,
      });
    });

    test("completion actions are scoped to the latest assistant message", async () => {
      const current =
        "Researching current browser support and collecting citations, but not complete yet.";
      await show(
        '<div data-message-author-role="assistant">Earlier complete answer with enough text to look finished.' +
          '<button data-testid="copy-turn-action-button"></button></div>' +
          `<div data-message-author-role="assistant">${current}</div>`,
      );
      const status = (await page.evaluate(buildDeepResearchStatusExpressionForTest())) as Record<
        string,
        unknown
      >;
      expect(status).toMatchObject({
        completed: false,
        placeholderOnly: false,
        textLength: current.length,
      });
    });

    test("a planning panel is an incomplete result", async () => {
      await show(
        '<div data-message-author-role="assistant" style="white-space:pre">' +
          "project root-cause analysis\nUpdate\nInspect the adapter.\n" +
          "Determining steps for creating a report...\nStop research</div>",
      );
      const poll = (await page.evaluate(
        buildDeepResearchCompletionPollExpressionForTest(),
      )) as Record<string, unknown>;
      expect(poll).toMatchObject({ finished: false, incompleteResult: true });
    });
  });
});
