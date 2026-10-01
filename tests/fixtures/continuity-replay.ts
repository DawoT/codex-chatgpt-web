import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import {
  ChatGptBrowserContextPressure,
  ChatGptPageDomObserver,
} from "../../src/adapters/chatgpt-web/browser/context-pressure";
import { waitForChatGptDomRevision } from "../../src/adapters/chatgpt-web/browser/dom-signal";
import { ChatGptCompletionTracker } from "../../src/adapters/chatgpt-web/browser/dom-trackers";
import { ResponseObserver } from "../../src/adapters/chatgpt-web/browser/response-observer";
import {
  type ChatGptSubmissionBaseline,
  SubmissionObserver,
} from "../../src/adapters/chatgpt-web/browser/submission-observer";
import { TurnDiagnostics } from "../../src/adapters/chatgpt-web/browser/turn-diagnostics";
import { ChatGptTurnEventBus } from "../../src/adapters/chatgpt-web/browser/turn-events";
import { ChatGptTurnPageBinding } from "../../src/adapters/chatgpt-web/browser/turn-page-binding";
import { inspectCompactionCheckpoint } from "../../src/adapters/chatgpt-web/compaction-policy";
import { CompactionTransactionStore } from "../../src/adapters/chatgpt-web/compaction-transaction";
import { measureCompiledBrowserPayload } from "../../src/adapters/chatgpt-web/input-tokens";
import { compileChatGptWebPrompt } from "../../src/adapters/chatgpt-web/prompt";
import {
  CHATGPT_LUNA_CHECKPOINT_MARKER,
  ChatGptLunaCheckpointStore,
  ChatGptLunaCheckpointStream,
} from "../../src/adapters/chatgpt-web/rolling-checkpoint";
import { ChatGptTextFeed, ChatGptTraceFeed } from "../../src/adapters/chatgpt-web/turn-execution/feeds";
import { ChatGptExternalTurnProgress, ChatGptMirroredTurnProgress } from "../../src/adapters/chatgpt-web/turn-progress";
import { estimateTokens } from "../../src/lib/token-estimate";
import {
  type CompactionStateBlock,
  formatCompactionStateBlock,
  parseCompactionState,
} from "../../src/responses/compaction";
import { parseRequest } from "../../src/responses/parser";
import { makeWorkerFixture } from "./worker-harness";

export const browserScenarios = ["late-ack", "lost-ack", "ambiguous-send"] as const;
export type BrowserReplayScenario = (typeof browserScenarios)[number];

export const codingTask = {
  request: "Refactor dedupe to O(n), preserve first occurrence order, test Unicode and empty input; do not deploy.",
  initialCode: [
    "function dedupe(values: string[]): string[] {",
    "  return values.filter((value, index) => values.indexOf(value) === index);",
    "}",
  ].join("\n"),
  nextAction: "Add the Unicode regression before changing dedupe, then run its targeted suite.",
  result: "Baseline evaluated: empty => []; repeated => [a,b]; order => [b,a]. Unicode regression pending.",
  answer: "Baseline is preserved. Next I will add the Unicode regression.",
};

// Authored scenario state, not purported model-generated or live-session evidence.
export const codingState: CompactionStateBlock = {
  version: 2,
  originalRequestRef: `sha256:${createHash("sha256").update(`${codingTask.request}\n${codingTask.initialCode}`).digest("hex")}`,
  modifiedFiles: [],
  activeHypothesis: "A Set can remove repeated lookups while preserving insertion order.",
  requirements: [
    { id: "REQ-O-N", status: "pending", source: "user: O(n) dedupe" },
    {
      id: "REQ-ORDER",
      status: "verified",
      source: "user: first occurrence order",
      evidence: codingTask.result,
    },
    { id: "REQ-UNICODE", status: "pending", source: "user: Unicode regression" },
    { id: "REQ-NO-DEPLOY", status: "pending", source: "user: do not deploy" },
  ],
  closureCriteria: ["Targeted dedupe tests pass and complexity is O(n)."],
  verifiedAchievements: [`Baseline results preserved; evidence: ${codingTask.result}`],
  decisionsAndInvariants: ["Do not deploy.", "Preserve first occurrence order."],
  blockersOrTestFailures: [],
  pendingObligations: ["Implement O(n).", "Add Unicode regression."],
  nextActions: [codingTask.nextAction],
};

export function resolveReplayBrowser(env: NodeJS.ProcessEnv = process.env): string {
  const installed = chromium.executablePath();
  const executable = env.CHATGPT_DOM_TEST_BROWSER || (existsSync(installed) ? installed : "/usr/bin/google-chrome");
  if (!statSync(executable).isFile()) {
    throw new Error(`Continuity replay requires a real Chromium executable: ${executable}`);
  }
  accessSync(executable, constants.X_OK);
  return executable;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createObservationControllers() {
  const pressure = new ChatGptBrowserContextPressure();
  const response = new ResponseObserver({
    pageDomObserver: new ChatGptPageDomObserver(),
    getContextPressure: () => pressure,
  });
  const submission = new SubmissionObserver({
    responseDomSnapshot: (locator, cache) => response.responseDomSnapshot(locator, cache),
  });
  const diagnostics = new TurnDiagnostics({
    submissionDomState: (...args) => submission.submissionDomState(...args),
    waitForTurnDomOrExternalProgress: (...args) => submission.waitForTurnDomOrExternalProgress(...args),
    waitForTurnDomRevisionOrExternalProgress: (...args) => submission.waitForTurnDomRevisionOrExternalProgress(...args),
    responseDomSnapshot: (locator, cache) => response.responseDomSnapshot(locator, cache),
    waitForSubmissionAccepted: (...args) => submission.waitForSubmissionAccepted(...args),
  });
  return { submission, response, diagnostics };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function replayGroup(key: string, prompt?: string, answer?: string): string {
  return [
    `<section data-turn-key="${escapeHtml(key)}">`,
    prompt === undefined
      ? ""
      : `<div data-user-message-bubble>
  <div data-search-result-target style="white-space: pre-wrap">${escapeHtml(prompt)}</div>
</div>`,
    answer === undefined
      ? ""
      : `<div data-content-search-unit-key="${escapeHtml(key)}:assistant">
  <div data-conversation-role="assistant"></div>
  <div data-markdown-text-style="assistant-message"><p>${escapeHtml(answer)}</p></div>
</div>
<div class="turn-action-controls"><button type="button">Copy</button></div>`,
    "</section>",
  ].join("\n");
}

async function renderConversation(page: Page, html: string): Promise<void> {
  await page.locator("main").evaluate((main, content) => {
    main.innerHTML = content;
  }, html);
}

// This bridge calls the constructed worker's real Send method. It replaces no browser effect.
// The method is still private in the worker; replace this bridge when A exports the send seam.
type RealSend = (
  page: Page,
  baseline: ChatGptSubmissionBaseline,
  capture: undefined,
  signal: AbortSignal,
  progress: undefined,
  lifecycle: { onSendActivated(): void; onSubmitted(): void },
  tracker: undefined,
  recovery: undefined,
  requireConnector: false,
  physicalComplete: () => void,
) => Promise<string>;

export async function runBrowserReplay(page: Page, scenario: BrowserReplayScenario) {
  const { submission, response, diagnostics } = createObservationControllers();
  const worker = makeWorkerFixture();
  const abort = new AbortController();
  const physical = deferred<void>();
  const lifecycle: string[] = [];
  const progress = new ChatGptExternalTurnProgress();
  try {
    await page.setContent(`
<!doctype html>
<html lang="en">
  <body data-sends="0">
    <main>${replayGroup("history")}</main>
    <form data-chatgpt-composer>
      <textarea id="prompt-textarea" aria-label="Prompt">${escapeHtml(codingTask.request)}</textarea>
      <button type="submit" data-testid="send-button">Send</button>
    </form>
    <script>
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
        document.body.dataset.sends = String(Number(document.body.dataset.sends) + 1);
      });
    </script>
  </body>
</html>
`);
    const baseline = await submission.captureSubmissionBaseline(page, codingTask.request);
    await renderConversation(page, replayGroup("history", "Earlier user", "Earlier answer"));
    const historicalEvidence = await submission.currentSubmissionEvidence(page, baseline);
    assert.equal(historicalEvidence, undefined, "Hydrating history must not acknowledge Send");
    const sendMethod = Reflect.get(worker, "sendAttachedPrompt");
    assert.equal(typeof sendMethod, "function", "The real worker Send API is required");
    const send = (sendMethod as RealSend).call(
      worker,
      page,
      baseline,
      undefined,
      abort.signal,
      undefined,
      {
        onSendActivated() {
          lifecycle.push("activated");
        },
        onSubmitted() {
          lifecycle.push("submitted");
        },
      },
      undefined,
      undefined,
      false,
      () => physical.resolve(),
    );
    // Attach rejection handling before injecting cancellation/transport faults.
    const sendOutcome = send.then(
      (evidence) => ({ evidence, error: undefined }),
      (error: unknown) => ({ evidence: undefined, error }),
    );
    await Promise.race([
      physical.promise,
      sendOutcome.then((outcome) => {
        if (outcome.error) {
          throw outcome.error;
        }
      }),
    ]);
    assert.equal(await page.locator("body").getAttribute("data-sends"), "1");
    if (scenario === "ambiguous-send") {
      assert.equal(await submission.currentSubmissionEvidence(page, baseline), undefined);
      abort.abort();
      const outcome = await sendOutcome;
      assert(outcome.error instanceof Error);
      assert.equal(outcome.error.name, "AbortError");
      assert.deepEqual(lifecycle, ["activated"]);
      return {
        scenario,
        historicalEvidence,
        sends: Number(await page.locator("body").getAttribute("data-sends")),
        lifecycle,
        identity: null,
        ack: "unproven" as const,
        text: "",
      };
    }

    await renderConversation(page, replayGroup("history") + replayGroup("accepted", codingTask.request));
    const accepted = await sendOutcome;
    assert.equal(accepted.error, undefined);
    assert.equal(accepted.evidence, "user_turn");
    assert.equal(baseline.acceptedUserIdentity, "group:user:accepted");
    await renderConversation(
      page,
      `${replayGroup("history")}
<section data-turn-key="activity"><span hidden data-chatgpt-agent-turn-start></span></section>`,
    );
    const binding = await diagnostics.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    assert.equal(binding.identity, "group:assistant:activity");
    await renderConversation(
      page,
      replayGroup("history", "Earlier user", "Earlier answer") +
        replayGroup("accepted", codingTask.request, codingTask.answer),
    );
    const rebound = await diagnostics.reconcileAssistantTurnBinding(page, baseline, binding);
    assert.equal(rebound.identity, "group:assistant:accepted");
    const snapshot = await response.responseDomSnapshot(rebound.locator, {});
    assert.equal(snapshot.visibleText, codingTask.answer);
    const tracker = new ChatGptCompletionTracker();
    const batch = progress.recordToolBatch(1, 100);
    const ackReached = deferred<void>();
    const ackRelease = deferred<void>();
    const mirror = new ChatGptMirroredTurnProgress(async (revision) => {
      assert.equal(revision, batch);
      assert.equal(tracker.needsToolBatchObservation(batch), false, "Capture must precede ACK");
      ackReached.resolve();
      await ackRelease.promise;
      if (scenario === "lost-ack") {
        throw new Error("Replay transport dropped ACK");
      }
      await progress.acknowledgeToolBatch(revision);
    });
    mirror.apply(progress.snapshot());
    const observation = submission.waitForSubmissionAccepted(page, baseline, abort.signal, mirror, 0, tracker);
    const observed = observation.then(
      (evidence) => ({ evidence, error: undefined }),
      (error: unknown) => ({ evidence: undefined, error }),
    );
    await ackReached.promise;
    let acknowledged = false;
    const ackWait = progress.waitForToolBatchObservation(batch, abort.signal, 10, undefined, 30).then(
      () => {
        acknowledged = true;
        return "accepted";
      },
      (error: Error) => error.name,
    );
    assert.equal(acknowledged, false, "Pending ACK must not be inferred from DOM completion");
    assert.equal(progress.snapshot().activeToolCalls, 1);
    ackRelease.resolve();
    const result = await observed;
    const ack = await ackWait;
    if (scenario === "late-ack") {
      assert.equal(result.evidence, "mcp_tool_call");
      assert.equal(ack, "accepted");
      progress.recordToolResult(101);
    } else {
      assert(result.error instanceof Error);
      assert.match(result.error.message, /dropped ACK/);
      assert.equal(ack, "ChatGptToolBoundaryObservationTimeoutError");
      assert.equal(progress.snapshot().activeToolCalls, 1, "Lost ACK cannot invent a tool result");
      progress.retire(new Error("Lost ACK: retire without resending"));
    }
    return {
      scenario,
      historicalEvidence,
      sends: Number(await page.locator("body").getAttribute("data-sends")),
      lifecycle,
      identity: rebound.identity,
      ack,
      text: snapshot.visibleText,
    };
  } finally {
    abort.abort();
    progress.retire(new Error("Replay cleanup"));
    await worker.close();
  }
}

function message(role: "user" | "assistant", text: string, turnId: string) {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function baselineEvaluation() {
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(codingTask.initialCode);
  const script = [
    'import assert from "node:assert/strict";',
    compiled,
    'const results = [dedupe([]), dedupe(["a", "a", "b"]), dedupe(["b", "a", "b"])];',
    'assert.deepEqual(results, [[], ["a", "b"], ["b", "a"]]);',
    'const format = (items) => "[" + items.join(",") + "]";',
    'console.log("Baseline evaluated: empty => " + format(results[0]) + "; repeated => " + format(results[1]) + "; order => " + format(results[2]) + ". Unicode regression pending.");',
    "console.log(JSON.stringify(results));",
  ].join("\n");
  const command = [process.execPath, "--eval", script];
  const child = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 1_000 });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  const output = child.stdout.toString().trim();
  const lines = output.split("\n");
  assert.equal(lines[0], codingTask.result);
  const results: string[][] = JSON.parse(lines[1]!);
  assert.deepEqual(results, [[], ["a", "b"], ["b", "a"]]);
  const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return {
    command: command.map(shellQuote).join(" "),
    output,
    exitCode: child.exitCode,
    results,
  };
}

export function codingRequest(
  threadId = "coding-thread",
  parentAnswer = codingTask.answer,
  evaluation?: ReturnType<typeof baselineEvaluation>,
) {
  return parseRequest({
    model: "gpt-5.6-luna",
    input: [
      message("user", `${codingTask.request}\n${codingTask.initialCode}`, "coding-turn-1"),
      ...(evaluation
        ? [
            {
              type: "function_call",
              call_id: "coding-baseline",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: evaluation.command }),
              internal_chat_message_metadata_passthrough: { turn_id: "coding-turn-1" },
            },
            {
              type: "function_call_output",
              call_id: "coding-baseline",
              output: JSON.stringify({ exit_code: evaluation.exitCode, output: evaluation.output }),
              internal_chat_message_metadata_passthrough: { turn_id: "coding-turn-1" },
            },
          ]
        : []),
      message("assistant", parentAnswer, "coding-turn-1"),
      message("user", "Continue, preserving the requirements and do not deploy.", "coding-turn-2"),
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "coding-turn-2" }),
    },
  });
}

export function runCodingReplay(path?: string) {
  const evaluation = baselineEvaluation();
  const original = codingRequest("coding-thread", codingTask.answer, evaluation);
  const stateText = formatCompactionStateBlock(codingState);
  const inspection = inspectCompactionCheckpoint({ ...original, _compactionRequest: true }, stateText, "coding-thread");
  assert.equal(inspection.valid, true, inspection.issues.join("; "));
  assert.deepEqual(inspection.state, codingState, "Strict inspection must preserve the authored v2 draft");
  const raw = `${codingTask.answer}\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${stateText}`;
  const stream = new ChatGptLunaCheckpointStream();
  let emitted = "";
  for (let index = 0; index < raw.length; index += 7) {
    emitted += stream.push(raw.slice(index, index + 7));
  }
  const completed = stream.finish(raw);
  assert.equal(emitted, codingTask.answer);
  const store = new ChatGptLunaCheckpointStore(path, () => 1_000);
  const initial = parseRequest({
    model: "gpt-5.6-luna",
    input: [message("user", `${codingTask.request}\n${codingTask.initialCode}`, "coding-turn-1")],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "coding-thread", turn_id: "coding-turn-1" }),
    },
  });
  store.commit(initial, completed.captured, completed.answer);
  const restored = path ? new ChatGptLunaCheckpointStore(path, () => 1_001) : store;
  const applied = restored.apply(original);
  assert.equal(applied.applied, true);
  const rawBody = applied.parsed._rawBody as { input: Array<{ content: Array<{ text: string }> }> };
  const context = rawBody.input[0]!.content[0]!.text;
  const checkpoint = JSON.parse(context.slice(context.indexOf('{"version"'))) as { summary: string };
  const parsedState = parseCompactionState(checkpoint.summary);
  assert.deepEqual(parsedState, codingState);
  const originalJson = JSON.stringify(original._rawBody);
  const compactedJson = JSON.stringify(applied.parsed._rawBody);
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: false,
    extraHighAvailable: false,
    proAvailable: false,
  };
  // parseRequest stamps ingestion time. The authored replay fixes only that input
  // metadata; subprocess results, transport bytes and measured durations stay real.
  const stableCodingSource = (parsed: ReturnType<typeof parseRequest>) => ({
    ...parsed,
    context: {
      ...parsed.context,
      messages: parsed.context.messages.map((entry, index) => ({ ...entry, timestamp: 1_000 + index })),
    },
  });
  const compiledOriginal = compileChatGptWebPrompt(stableCodingSource(original), capabilities);
  const compiledCheckpoint = compileChatGptWebPrompt(stableCodingSource(applied.parsed), capabilities);
  return {
    original,
    applied,
    restored,
    parsedState,
    emitted,
    baselineResults: evaluation.results,
    inspection,
    payload: {
      originalBytes: Buffer.byteLength(originalJson),
      checkpointBytes: Buffer.byteLength(compactedJson),
      originalTokens: estimateTokens(originalJson),
      checkpointTokens: estimateTokens(compactedJson),
      browserOriginal: measureCompiledBrowserPayload(compiledOriginal, original.modelId),
      browserCheckpoint: measureCompiledBrowserPayload(compiledCheckpoint, applied.parsed.modelId),
      originalCompilation: compiledOriginal.compilation,
      checkpointCompilation: compiledCheckpoint.compilation,
    },
  };
}

export async function runLifecycleReplay(cycles = 100) {
  const baseline = { busWaiters: 0, textWaiters: 0, traceWaiters: 0, transactions: 0, abortListeners: 0 };
  let final = { ...baseline };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const bus = new ChatGptTurnEventBus({ turnId: `cycle-${cycle}` });
    const text = new ChatGptTextFeed();
    const trace = new ChatGptTraceFeed();
    const transactions = new CompactionTransactionStore();
    const abort = new AbortController();
    const counts = () => ({
      busWaiters: bus.pendingWaiters,
      textWaiters: text.pendingWaiters,
      traceWaiters: trace.pendingWaiters,
      transactions: transactions.pendingTransactions,
      abortListeners: getEventListeners(abort.signal, "abort").length,
    });
    assert.deepEqual(counts(), baseline);
    const busWait = bus.waitUntil("dom_settled", undefined, { signal: abort.signal, deadlineMs: 1_000 });
    const textWait = text.wait(abort.signal);
    const traceWait = trace.wait(abort.signal);
    const handle = transactions.begin(`cycle-${cycle}`, 1_000);
    const transactionWait = transactions.wait(handle.token, abort.signal);
    const pending = [busWait, textWait, traceWait, transactionWait];
    // Observe rejection immediately, then trigger the real lifecycle below.
    const outcomes = Promise.allSettled(pending);
    assert.deepEqual(counts(), {
      busWaiters: 1,
      textWaiters: 1,
      traceWaiters: 1,
      transactions: 1,
      abortListeners: 4,
    });
    try {
      if (cycle % 3 === 0) {
        bus.publish({ type: "dom_settled", source: "dom", at: cycle });
        text.push("preserved delta");
        trace.push({ kind: "commentary", text: "preserved trace" });
        transactions.submit(handle.token, handle.handoffId, "preserved checkpoint");
        const result = await outcomes;
        assert(result.every((entry) => entry.status === "fulfilled"));
        assert.deepEqual(text.drain(), ["preserved delta"]);
        assert.equal(trace.drain()[0]?.text, "preserved trace");
        assert.equal(result[3]?.status === "fulfilled" ? result[3].value : null, "preserved checkpoint");
      } else if (cycle % 3 === 1) {
        abort.abort();
        assert((await outcomes).every((entry) => entry.status === "rejected"));
      } else {
        bus.dispose();
        text.close(new Error("cycle retired"));
        trace.close(new Error("cycle retired"));
        transactions.close();
        assert((await outcomes).every((entry) => entry.status === "rejected"));
      }
      assert.deepEqual(counts(), baseline);
      bus.dispose();
      text.close();
      trace.close();
      transactions.close();
      await assert.rejects(bus.waitUntil("dom_settled"), /disposed/);
      await assert.rejects(transactions.wait(handle.token), /invalid|expired|consumed/);
      final = counts();
      assert.deepEqual(final, baseline);
    } finally {
      abort.abort();
      bus.dispose();
      text.close();
      trace.close();
      transactions.close();
    }
  }
  return { cycles, baseline, final };
}

// Renderer counters are the diagnostics explicitly supplied by A for this cancellation seam.
async function rendererCounts(page: Page) {
  return page.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __CODEX_WEB_GPT_DOM_SIGNAL__?: { waiters: unknown[]; cancellations: Map<string, () => void> };
    };
    return {
      domWaiters: scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.waiters.length ?? 0,
      domCancellations: scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.cancellations.size ?? 0,
    };
  });
}

function responseListenerCount(page: Page): number {
  const method: unknown = Reflect.get(page, "listenerCount");
  assert(typeof method === "function", "Page runtime must expose the EventEmitter listener counter");
  const count: unknown = Reflect.apply(method, page, ["response"]);
  assert(typeof count === "number");
  return count;
}

export async function runPageLifecycleReplay(first: Page, replacement: Page, cycles = 100) {
  await first.setContent("<main>Lifecycle cancellation</main>");
  const initial = await waitForChatGptDomRevision(first, { settleMs: 0, horizonMs: 1 });
  const baseline = {
    firstListeners: responseListenerCount(first),
    replacementListeners: responseListenerCount(replacement),
    ...(await rendererCounts(first)),
    abortListeners: 0,
  };
  let final = { ...baseline };
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const bus = new ChatGptTurnEventBus({ turnId: `page-cycle-${cycle}` });
    const binding = new ChatGptTurnPageBinding(bus);
    const abort = new AbortController();
    try {
      binding.bind(first);
      binding.bind(first);
      assert.equal(responseListenerCount(first), baseline.firstListeners + 1);
      binding.bind(replacement);
      assert.equal(responseListenerCount(first), baseline.firstListeners);
      assert.equal(responseListenerCount(replacement), baseline.replacementListeners + 1);
      assert.equal(bus.documentGeneration, 1);
      const waiting = waitForChatGptDomRevision(first, {
        afterKey: initial.key,
        signal: abort.signal,
        requireMutation: true,
        horizonMs: 10_000,
      });
      const outcome = waiting.then(
        () => null,
        (error: unknown) => error,
      );
      await first.waitForFunction(() => {
        const scope = globalThis as typeof globalThis & {
          __CODEX_WEB_GPT_DOM_SIGNAL__?: { cancellations: Map<string, () => void> };
        };
        return scope.__CODEX_WEB_GPT_DOM_SIGNAL__?.cancellations.size === 1;
      });
      assert.deepEqual(await rendererCounts(first), { domWaiters: 1, domCancellations: 1 });
      abort.abort();
      const error = await outcome;
      assert(error instanceof Error);
      assert.equal(error.name, "AbortError");
      binding.dispose();
      binding.dispose();
      bus.dispose();
      final = {
        firstListeners: responseListenerCount(first),
        replacementListeners: responseListenerCount(replacement),
        ...(await rendererCounts(first)),
        abortListeners: getEventListeners(abort.signal, "abort").length,
      };
      assert.deepEqual(final, baseline, `Page lifecycle leak at cycle ${cycle}`);
    } finally {
      abort.abort();
      binding.dispose();
      bus.dispose();
    }
  }
  return { cycles, baseline, final };
}

export const replayScenarioDigest = createHash("sha256")
  .update(JSON.stringify({ browserScenarios, codingTask, codingState }))
  .digest("hex");
