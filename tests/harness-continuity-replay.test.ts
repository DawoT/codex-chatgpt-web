import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";
import { summarizeLatencies } from "../scripts/check-harness-continuity";
import { ChatGptBrowserContextPressure } from "../src/adapters/chatgpt-web/browser/context-pressure";
import { waitForChatGptDomRevision } from "../src/adapters/chatgpt-web/browser/dom-signal";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser/dom-trackers";
import { TurnCompletionLoop } from "../src/adapters/chatgpt-web/browser/turn-completion-loop";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";
import { resolveTurnLivenessSignals } from "../src/adapters/chatgpt-web/browser/turn-liveness";
import { waitForChatGptTurnWake } from "../src/adapters/chatgpt-web/browser/turn-wake";
import { inspectCompactionCheckpoint } from "../src/adapters/chatgpt-web/compaction-policy";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import {
  measureCompiledBrowserPayload,
  measureCompiledChatGptWebInput,
} from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { classifyTurnTermination } from "../src/adapters/chatgpt-web/turn-terminal";
import { formatCompactionStateBlock } from "../src/responses/compaction";
import {
  browserScenarios,
  codingRequest,
  codingState,
  codingTask,
  createObservationControllers,
  replayGroup,
  resolveReplayBrowser,
  runBrowserReplay,
  runCodingReplay,
  runLifecycleReplay,
  runPageLifecycleReplay,
} from "./fixtures/continuity-replay";
import { makeLauncherTurn } from "./fixtures/worker-harness";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: resolveReplayBrowser(), headless: true });
});

afterAll(async () => {
  await browser?.close();
});

for (const scenario of browserScenarios) {
  test(`real Chromium continuity replay: ${scenario}; one physical Send`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const result = await runBrowserReplay(page, scenario);
      expect(result.sends).toBe(1);
      expect(result.historicalEvidence).toBeUndefined();
      if (scenario === "ambiguous-send") {
        expect(result.lifecycle).toEqual(["activated"]);
        expect(result.ack).toBe("unproven");
      } else {
        expect(result.lifecycle).toEqual(["activated", "submitted"]);
        expect(result.identity).toBe("group:assistant:accepted");
        expect(result.text).toBe(codingTask.answer);
        expect(result.ack).toBe(scenario === "late-ack" ? "accepted" : "ChatGptToolBoundaryObservationTimeoutError");
      }
    } finally {
      await context.close();
    }
  });
}

test("foreign user identity is rejected after Activity detaches the bound answer", async () => {
  const page = await browser.newPage();
  try {
    const { submission, diagnostics } = createObservationControllers();
    await page.setContent("<main></main>");
    const baseline = await submission.captureSubmissionBaseline(page, codingTask.request);
    await page.locator("main").evaluate(
      (main, html) => {
        main.innerHTML = html;
      },
      replayGroup("accepted", codingTask.request),
    );
    expect(await submission.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    await page.locator("main").evaluate((main) => {
      main.innerHTML = '<section data-turn-key="activity"><span hidden data-chatgpt-agent-turn-start></span></section>';
    });
    const binding = await diagnostics.waitForNewAssistantTurn(page, baseline, Date.now() + 1_000);
    await page.locator("main").evaluate(
      (main, html) => {
        main.innerHTML = html;
      },
      replayGroup("foreign", codingTask.request, codingTask.answer),
    );
    await expect(diagnostics.reconcileAssistantTurnBinding(page, baseline, binding)).rejects.toThrow(
      "another user turn",
    );
  } finally {
    await page.close();
  }
});

test("coding evaluation survives a persisted intermediate checkpoint with requirements, results and next action", () => {
  const directory = mkdtempSync(join(tmpdir(), "continuity-coding-"));
  try {
    const result = runCodingReplay(join(directory, "checkpoint.json"));
    expect(result.baselineResults).toEqual([[], ["a", "b"], ["b", "a"]]);
    expect(result.parsedState?.requirements?.map((requirement) => requirement.id)).toEqual([
      "REQ-O-N",
      "REQ-ORDER",
      "REQ-UNICODE",
      "REQ-NO-DEPLOY",
    ]);
    expect(result.parsedState?.verifiedAchievements).toEqual([
      `Baseline results preserved; evidence: ${codingTask.result}`,
    ]);
    expect(result.parsedState?.nextActions).toEqual([codingTask.nextAction]);
    expect(result.parsedState?.pendingObligations).toEqual(["Implement O(n).", "Add Unicode regression."]);
    expect(extractChatGptTurnUserRevision(result.applied.parsed)).toEqual(
      extractChatGptTurnUserRevision(result.original),
    );
    for (const request of [codingRequest("foreign-thread"), codingRequest("coding-thread", "Other answer")]) {
      const fallback = result.restored.apply(request);
      expect(fallback.applied).toBeFalse();
      expect(fallback.parsed).toBe(request);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("100 lifecycle cycles release real event waiters and abort listeners", async () => {
  const result = await runLifecycleReplay();
  expect(result.cycles).toBe(100);
  expect(result.final).toEqual({ busWaiters: 0, textWaiters: 0, traceWaiters: 0, transactions: 0, abortListeners: 0 });
});

test("100 real Chromium rebind/cancellation cycles return page and renderer resources to baseline", async () => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const replacement = await context.newPage();
    const result = await runPageLifecycleReplay(first, replacement);
    expect(result.cycles).toBe(100);
    expect(result.final).toEqual(result.baseline);
    expect(result.final.domWaiters).toBe(0);
    expect(result.final.domCancellations).toBe(0);
    expect(result.final.abortListeners).toBe(0);
  } finally {
    await context.close();
  }
});

test("rebind advances document generation and cursor rejects stale replay", async () => {
  const bus = new ChatGptTurnEventBus({ turnId: "rebind" });
  try {
    const first = bus.publish({ type: "dom_settled", source: "dom", at: 1 });
    const waiting = bus.waitUntil("dom_settled", undefined, { afterSequence: bus.cursor, deadlineMs: 1_000 });
    const rebound = bus.publish({ type: "page_rebound", source: "host", at: 2 });
    expect(rebound.documentGeneration).toBe(1);
    const next = bus.publish({ type: "dom_settled", source: "dom", at: 3 });
    const observed = await waiting;
    expect(observed.sequence).toBe(next.sequence);
    expect(observed.documentGeneration).toBe(1);
    expect(observed.at).toBe(3);
    expect(next.sequence).toBeGreaterThan(first.sequence);
    for (let index = 0; index < 40; index += 1) {
      bus.publish({ type: "response_mutated", source: "dom", at: 4 + index });
    }
    await expect(bus.waitUntil("dom_settled", undefined, { afterSequence: first.sequence })).rejects.toThrow(
      "resynchronization",
    );
  } finally {
    bus.dispose();
  }
});

test("gate computes nearest-rank percentiles from measured samples and rejects absent evidence", () => {
  const statistics = summarizeLatencies([20, 1, 10, 4, 3]);
  expect(statistics.p50Ms).toBe(4);
  expect(statistics.p95Ms).toBe(20);
  expect(statistics.sampleCount).toBe(5);
  expect(() => summarizeLatencies([])).toThrow("real samples");
  expect(() => summarizeLatencies([Number.NaN])).toThrow();
});

test("strict checkpoint validation exposes a missing original request reference in an otherwise complete v2 draft", () => {
  const parsed = codingRequest();
  parsed._compactionRequest = true;
  const draft = formatCompactionStateBlock({
    ...codingState,
    originalRequestRef: undefined,
    requirements: codingState.requirements?.map((requirement) => ({
      ...requirement,
      status: "pending" as const,
      evidence: undefined,
    })),
    verifiedAchievements: [],
  });
  const inspected = inspectCompactionCheckpoint(parsed, draft);
  expect(inspected.valid).toBeFalse();
  expect(inspected.issues).toContain("Missing original request reference");
});

test("a consumer cannot poison memoized input metrics returned by the public API", () => {
  const compiled = { text: "actual source", images: [] };
  const measured = measureCompiledChatGptWebInput(compiled, "gpt-5.6-luna");
  expect(measured.maxMessageTokens).toBe(2);
  Reflect.set(measured, "maxMessageTokens", 0);
  const subsequent = measureCompiledChatGptWebInput(compiled, "gpt-5.6-luna");
  expect(subsequent.maxMessageTokens).toBe(2);
  const payload = measureCompiledBrowserPayload(compiled, "gpt-5.6-luna");
  Reflect.set(payload.messageTokensEstimated, "0", 0);
  expect(measureCompiledBrowserPayload(compiled, "gpt-5.6-luna").messageTokensEstimated[0]).toBe(2);
});

test("compilation payload identity changes when multipart task records change with the same commit", () => {
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
    experimentalBiggerContext: true,
  };
  const compile = (content: string) =>
    compileChatGptWebPrompt(
      {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" },
        context: {
          systemPrompt: [],
          messages: [{ role: "user", content, timestamp: 1 }],
        },
      },
      capabilities,
      undefined,
      { experimentalMultipartParts: 6 },
    );
  const alpha = compile("Requirement ALPHA, preserve this exact task.");
  const bravo = compile("Requirement BRAVO, preserve this exact task.");
  expect(alpha.multipart).toBeDefined();
  expect(bravo.multipart).toBeDefined();
  expect(alpha.multipart?.parts).not.toEqual(bravo.multipart?.parts);
  expect(alpha.text).toBe(bravo.text);
  expect(alpha.compilation?.payloadSha256).not.toBe(bravo.compilation?.payloadSha256);
});

test("real renderer timeout and an already-delivered progress race release losing observation resources", async () => {
  const page = await browser.newPage();
  const bus = new ChatGptTurnEventBus({ turnId: "race-timeout" });
  const progress = new ChatGptExternalTurnProgress();
  try {
    await page.setContent("<main>Quiet race scenario</main>");
    const first = await waitForChatGptDomRevision(page);
    await expect(
      waitForChatGptDomRevision(page, {
        afterKey: first.key,
        horizonMs: 10_000,
        observationTimeoutMs: 50,
      }),
    ).rejects.toThrow("did not respond");
    const { submission } = createObservationControllers();
    progress.recordClaim(100);
    await waitForChatGptTurnWake(bus, async (signal) => {
      expect(bus.pendingWaiters).toBe(5);
      await submission.waitForTurnDomRevisionOrExternalProgress(page, first.key, 0, progress, signal, {
        horizonMs: 10_000,
      });
    });
    const resources = await page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_DOM_SIGNAL__?: { waiters: unknown[]; cancellations: Map<string, () => void> };
      };
      return {
        waiters: scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.waiters.length,
        cancellations: scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.cancellations.size,
      };
    });
    expect(resources).toEqual({ waiters: 0, cancellations: 0 });
    expect(bus.pendingWaiters).toBe(0);
  } finally {
    progress.retire(new Error("Race replay cleanup"));
    bus.dispose();
    await page.close();
  }
});

test("normalization stays bounded on a malformed checkpoint containing 560KB of whitespace", () => {
  const script = [
    'import { normalizeCompactionStateBlock } from "./src/responses/compaction";',
    'const raw = "<compaction_state>" + " ".repeat(560000) + "X</compaction_state>";',
    "const normalized = normalizeCompactionStateBlock(raw);",
    'if (!normalized.includes("X")) {',
    '  throw new Error("Lost checkpoint literal");',
    "}",
  ].join("\n");
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 1_500,
  });
  expect(child.exitCode).toBe(0);
  expect(child.signalCode == null).toBe(true);
});

test("the real completion deadline is reported as deadline rather than an internal failure", async () => {
  const page = await browser.newPage();
  const bus = new ChatGptTurnEventBus({ turnId: "expired-deadline" });
  try {
    await page.setContent("<main>Deadline scenario</main>");
    const controllers = createObservationControllers();
    const baseline = await controllers.submission.captureSubmissionBaseline(page);
    const loop = new TurnCompletionLoop({
      config: { appName: "Codex Native", autoApproveToolCalls: false },
      classifyLiveness: resolveTurnLivenessSignals,
      responseDomSnapshot: (...args) => controllers.response.responseDomSnapshot(...args),
      reconcileAssistantTurnBinding: (...args) => controllers.diagnostics.reconcileAssistantTurnBinding(...args),
      waitForTurnDomRevisionOrExternalProgress: (...args) =>
        controllers.submission.waitForTurnDomRevisionOrExternalProgress(...args),
      stalledTurnDiagnostic: () => page.content(),
      rebindLauncherPage: async () => {
        throw new Error("An expired deadline must not attempt page recovery");
      },
    });
    const outcome = await loop
      .run({
        turn: makeLauncherTurn("expired-deadline"),
        page,
        submissionBaseline: baseline,
        responseTurn: { identity: "expired", locator: page.locator("main"), acceptedTurnIdentities: [] },
        localTools: false,
        deadline: 0,
        completionTracker: new ChatGptCompletionTracker(),
        contextPressure: new ChatGptBrowserContextPressure(),
        diagnostics: { capture: async () => {} },
        turnEvents: bus,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(Error);
    expect(classifyTurnTermination(outcome)).toBe("deadline");
  } finally {
    bus.dispose();
    await page.close();
  }
});
