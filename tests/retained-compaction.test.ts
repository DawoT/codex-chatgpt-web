import { beforeEach, expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  cancelAllStructuredCompactions,
  canonicalizeCompactionHandoff,
  cancelStructuredCompactionNativeTurn,
  cancelStructuredCompactionTrace,
  existingStructuredCompactionRun,
  requestRetainedCompactionHandoff,
  runStructuredCompactionOnce,
  settleActiveCompactionSource,
  settleActiveZeroRiskCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import {
  chatGptWebExecutionNamespace,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/responses/compaction";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  CODEX_ACTIVE_COMPACTION_REQUEST_MARKER,
  structuredCompactionHandoffInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

/**
 * These fixtures hand the turn broker a Unix socket under their temp root. macOS puts TMPDIR at
 * /var/folders/<32 chars>/T, which pushes `<root>/runtime/turn-broker.sock` past the 104-byte
 * sun_path limit, and listen() then fails with nothing but "Failed to listen". Root them somewhere
 * short so the socket is bindable.
 */
function shortSocketTempRoot(): string {
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

let nativeFixtureId = 0;
beforeEach(() => {
  nativeFixtureId += 1;
});

function nativeThreadId(): string {
  return `thread_retained_compaction_${nativeFixtureId}`;
}

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: nativeThreadId(),
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

test("canonical handoff preserves the first user request across later checkpoints", () => {
  const first = request(true);
  const checkpoint = canonicalizeCompactionHandoff(first, missionCheckpoint("Continue the task."));
  expect(checkpoint).toContain('CODEX_ORIGINAL_USER_REQUEST_JSON\n{"sha256":');
  expect(checkpoint).toContain('"text":"Original task"');
  expect(checkpoint).toMatch(/original_request_ref: sha256:[a-f0-9]{64}/);

  const later = request(true);
  later.context.messages = [
    { role: "user", origin: "compaction_summary", content: checkpoint, timestamp: 4 },
    { role: "user", content: "A later instruction", timestamp: 5 },
  ];
  const next = canonicalizeCompactionHandoff(later, missionCheckpoint("Continue the task."));
  expect(next).toContain('"text":"Original task"');
  expect(next).not.toContain('"text":"A later instruction"');
  expect(next.match(/original_request_ref: sha256:[a-f0-9]{64}/)?.[0])
    .toBe(checkpoint.match(/original_request_ref: sha256:[a-f0-9]{64}/)?.[0]);
  later.context.messages[0] = {
    role: "user",
    origin: "compaction_summary",
    content: checkpoint.replace('"text":"Original task"', '"text":"Another task"'),
    timestamp: 4,
  };
  expect(() => canonicalizeCompactionHandoff(later, missionCheckpoint("Continue the task.")))
    .toThrow("original-request marker");
});

test("canonical handoff rewrites the real state rather than an earlier fenced example", () => {
  const draft = [
    "Example:",
    "```xml",
    "<compaction_state>",
    "original_request_ref: example only",
    "</compaction_state>",
    "```",
    missionCheckpoint("Real checkpoint"),
  ].join("\n");
  const canonical = canonicalizeCompactionHandoff(request(true), draft);
  expect(canonical).toContain("original_request_ref: example only");
  expect(canonical).toMatch(/original_request_ref: sha256:[a-f0-9]{64}/);
  expect(canonical.indexOf("original_request_ref: sha256:")).toBeGreaterThan(
    canonical.indexOf("```\n"),
  );
});

test("canonical handoff finds the latest validated original request after legacy checkpoints", () => {
  const checkpoint = canonicalizeCompactionHandoff(request(true), missionCheckpoint("First checkpoint"));
  const later = request(true);
  later.context.messages = [
    { role: "user", origin: "compaction_summary", content: "Legacy checkpoint without an original-request marker", timestamp: 4 },
    { role: "user", origin: "compaction_summary", content: checkpoint, timestamp: 5 },
    { role: "user", content: "A later instruction", timestamp: 6 },
  ];

  expect(canonicalizeCompactionHandoff(later, missionCheckpoint("Next checkpoint")))
    .toContain('"text":"Original task"');
  later.context.messages.splice(1, 1);
  expect(() => canonicalizeCompactionHandoff(later, missionCheckpoint("Next checkpoint")))
    .toThrow("no recoverable original-request marker");
});

function missionCheckpoint(narrative: string): string {
  return `${narrative}
<compaction_state>
version: 2
original_request_ref: user turn turn_source
modified_files:
active_hypothesis: Continue the original task.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn turn_source: Continue with the next step"}
closure_criteria:
- Complete the next step
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
- None
pending_obligations:
- Continue with the next step
next_actions:
- Continue with the next step
</compaction_state>`;
}

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`Missing compaction control binding: ${instruction}`);
  return { token, handoffId };
}

test("one browser conversation spans native turns and rotates only at compaction", () => {
  const before = request(false);
  const sameTurn = structuredClone(before);
  (sameTurn._rawBody as { input: unknown[] }).input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Same native turn revision" }],
  });
  const nextTurn = structuredClone(before);
  (nextTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: nativeThreadId(),
      turn_id: "turn_next",
    }),
  };
  const afterCompact = structuredClone(before);
  (afterCompact._rawBody as { input: unknown[] }).input.unshift({
    type: "compaction",
    encrypted_content: "ocx1:checkpoint",
  });

  expect(chatGptConversationKey(sameTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(nextTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(afterCompact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherModel = structuredClone(before);
  otherModel.modelId = "chatgpt-web/pro";
  expect(chatGptConversationKey(otherModel, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherEffort = structuredClone(before);
  otherEffort.options.reasoning = "medium";
  expect(chatGptConversationKey(otherEffort, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherThread = structuredClone(before);
  (otherThread._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_other",
      turn_id: "turn_source",
    }),
  };
  expect(chatGptConversationKey(otherThread, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  expect(retainedConversationResumeRequest(before)?.context.messages).toEqual([
    { role: "user", content: "Continue with the next step", timestamp: 3 },
  ]);

  const v1Compact = structuredClone(before);
  (v1Compact._rawBody as { input: unknown[] }).input.unshift({
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\ncheckpoint` }],
  });
  expect(chatGptConversationKey(v1Compact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
});

test("compaction capability is one-shot and structurally bound to its handoff id", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace_compaction", 1_000);
  expect(() => store.submit(transaction.token, "handoff_wrong", "checkpoint")).toThrow("does not match");
  store.submit(transaction.token, transaction.handoffId, "  exact checkpoint  ");
  await expect(store.wait(transaction.token)).resolves.toBe("exact checkpoint");
  expect(() => store.submit(transaction.token, transaction.handoffId, "again")).toThrow("invalid, expired, or consumed");
  store.close();
});

test("an empty control handoff consumes its capability for validation and repair", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace_empty_handoff", 1_000);
  store.submit(transaction.token, transaction.handoffId, "  \n  ");
  await expect(store.wait(transaction.token)).resolves.toBe("");
  expect(() => store.submit(transaction.token, transaction.handoffId, "later"))
    .toThrow("invalid, expired, or consumed");
  store.close();
});

test("retained compaction provides one exact same-agent control binding", () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "control_11111111111111111111111111111111",
    handoffId: "handoff_22222222222222222222222222222222",
  });
  expect(prompt).toContain("Automatic Codex context compaction has started.");
  expect(prompt).toContain("Stop ordinary task work");
  expect(prompt).toContain("turn_token control_11111111111111111111111111111111");
  expect(prompt).toContain("wire_name codex.control.compaction_handoff");
  expect(prompt).toContain('"handoff_id":"handoff_22222222222222222222222222222222"');
  expect(prompt).toContain("do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool");
  expect(prompt).toContain("submitted=true");
});

test("a compaction control token cannot claim the ordinary Codex tool environment", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-capability-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace_capability", 1_000);
    await expect(callTurnBroker(broker.socketPath, {
      method: "claim",
      token: transaction.token,
    })).rejects.toThrow("turn token is invalid");
    await callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Bound checkpoint",
    });
    await expect(broker.waitForCompactionHandoff(transaction.token)).resolves.toBe("Bound checkpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction delivers the current result and converts every later MCP call into the checkpoint request", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-active-compaction-gate-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    // The assertion exercises compaction routing, not expiry. Leave enough lease headroom for
    // Windows named-pipe scheduling under the full parallel test suite.
    }, 30_000, "trace_active_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const current = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    });
    const [request] = await broker.nextToolBatch(token);
    broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "current result" }],
    });
    await expect(current).resolves.toMatchObject({
      content: [{ type: "text", text: "current result" }],
    });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "git status --short" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction drains an MCP call already queued without an outer Codex waiter", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-queued-before-compaction-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_prequeued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    await Bun.sleep(25);
    const interrupted = broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(interrupted).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
    broker.revoke(token);
    expect(() => broker.compactionDeliveryCount(token)).toThrow("turn capability retired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed retained agent returns an exact checkpoint and its browser is physically retired", async () => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(5 * 60_000);
  const sourceRequest = request(false);
  const conversationKey = chatGptConversationKey(sourceRequest, "provider")!;
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    cancel() {},
  });
  let captured: BrowserTurn | undefined;
  let browserRetired = false;
  let transactionAborted = false;
  let transactionTtl = 0;
  const broker = {
    beginCompactionTransaction: async (_traceId: string, ttlMs: number) => {
      transactionTtl = ttlMs;
      return {
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
      };
    },
    waitForCompactionHandoff: async () => "Retained agent checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    run: async (turn: BrowserTurn): Promise<string> => {
      captured = turn;
      const prepared = await turn.prepareResume!();
      expect(prepared.text).toContain("wire_name codex.control.compaction_handoff");
      prepared.release();
      return await new Promise<string>((_resolve, reject) => {
        const onAbort = () => {
          browserRetired = true;
          reject(new DOMException("retained handoff browser closed", "AbortError"));
        };
        if (turn.abortSignal?.aborted) onAbort();
        else turn.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_handoff",
    undefined,
    60 * 60_000,
  )).resolves.toBe("Retained agent checkpoint");
  expect(captured?.conversationKey).toBe(conversationKey);
  expect(captured?.requireRetainedConversation).toBeTrue();
  expect(captured?.nativeConnector).toBeTrue();
  expect(captured?.capabilities.localToolsEnabled).toBeFalse();
  expect(browserRetired).toBeTrue();
  expect(captured?.abortSignal?.reason).toBeInstanceOf(ChatGptCompactionHandoffAccepted);
  expect(transactionAborted).toBeTrue();
  expect(transactionTtl).toBe(MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
});

test("completed retained compaction never treats ordinary assistant text as a handoff", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => { throw new Error("structured handoff missing"); },
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  const worker = {
    run: async () => '{"checkpoint":"must never be parsed"}',
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_no_text_fallback",
  )).rejects.toThrow("structured handoff missing");
});

test("a settled browser response without a checkpoint reports the missing handoff immediately", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-handoff-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  const abort = new AbortController();
  const guard = setTimeout(() => abort.abort(new Error("test observation guard")), 1000);
  try {
    await expect(requestRetainedCompactionHandoff(
      { run: async () => "The requested tool call did not run." } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_missing_handoff", abort.signal,
    )).rejects.toMatchObject({ code: "compaction_handoff_missing", retryable: false });
  } finally {
    clearTimeout(guard);
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a checkpoint submitted before browser completion wins the terminal response race", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-handoff-race-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only", browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(), trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    usageInput: sourceRequest, conversationKey: chatGptConversationKey(sourceRequest, "provider")!, cancel() {},
  });
  try {
    await expect(requestRetainedCompactionHandoff(
      { run: async (turn: BrowserTurn) => {
        const prepared = await turn.prepare();
        const token = prepared.text.match(/turn_token (control_\w+)/)![1]!;
        const handoffId = prepared.text.match(/handoff_id (handoff_\w+)/)![1]!;
        await callTurnBroker(broker.socketPath, { method: "submit_compaction_handoff", token, handoffId, summary: "Exact summary" });
        prepared.release();
        return "Checkpoint submitted.";
      } } as never,
      request(true), source, broker,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      "trace_handoff_race",
    )).resolves.toBe("Exact summary");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained compaction deadline bounds browser settlement after the control handoff succeeds", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  let transactionAborted = false;
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => "Already submitted checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    run: async () => new Promise<string>(() => {}),
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    "trace_deadline",
    undefined,
    25,
  )).rejects.toThrow("timed out after 25ms");
  expect(transactionAborted).toBeTrue();
});

test("a failed exact compaction replays its failure instead of reopening the browser", async () => {
  const key = `exact-retry-${Date.now()}-${Math.random()}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] };
  let starts = 0;
  const failed = runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    throw new Error("first handoff failed");
  });
  await expect(failed).rejects.toThrow("first handoff failed");
  await Bun.sleep(0);
  expect(existingStructuredCompactionRun(key)).toBe(failed);

  const retry = runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    return "must not submit a second handoff";
  });
  expect(retry).toBe(failed);
  await expect(retry).rejects.toThrow("first handoff failed");
  expect(starts).toBe(1);

  await expect(runStructuredCompactionOnce(`${key}-new-turn`, owner, async () => {
    starts += 1;
    return "operator-started checkpoint";
  })).resolves.toBe("operator-started checkpoint");
  expect(starts).toBe(2);
});

test("a changed compaction revision in the same native epoch cannot start a second browser", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-revision-${suffix}`,
    revisionScopeKey: `thread-turn-epoch-${suffix}`,
    traceIds: [`trace-revision-${suffix}`],
    nativeThreadId: `thread-${suffix}`,
    nativeTurnId: `turn-${suffix}`,
  };
  let release!: (value: string) => void;
  const firstBrowser = new Promise<string>(resolve => { release = resolve; });
  let starts = 0;
  const first = runStructuredCompactionOnce(`revision-a-${suffix}`, owner, async () => {
    starts += 1;
    return firstBrowser;
  });
  try {
    await Bun.sleep(0);
    const changed = runStructuredCompactionOnce(`revision-b-${suffix}`, owner, async () => {
      starts += 1;
      return "duplicate browser";
    });
    const outcome = await Promise.race([
      changed.then(() => "started", error => (error as { code?: string }).code ?? "other_error"),
      Bun.sleep(25).then(() => "pending"),
    ]);
    expect(outcome).toBe("compaction_revision_conflict");
    expect(starts).toBe(1);
  } finally {
    release("first checkpoint");
    await first;
  }
});

test("a consumed checkpoint epoch permits a later compaction in the same native turn", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-epoch-${suffix}`,
    revisionScopeKey: `thread-turn-initial-${suffix}`,
    traceIds: [`trace-epoch-${suffix}`],
    nativeThreadId: `thread-${suffix}`,
    nativeTurnId: `turn-${suffix}`,
  };
  let starts = 0;
  await runStructuredCompactionOnce(`epoch-a-${suffix}`, owner, async () => {
    starts += 1;
    return "first checkpoint";
  });
  await expect(runStructuredCompactionOnce(`epoch-b-${suffix}`, {
    ...owner,
    revisionScopeKey: `thread-turn-accepted-checkpoint-${suffix}`,
  }, async () => {
    starts += 1;
    return "later checkpoint";
  })).resolves.toBe("later checkpoint");
  expect(starts).toBe(2);
});

test("expired replay cache never reopens a completed native compact epoch", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const key = `expired-epoch-${suffix}`;
  const owner = {
    ownerKey: `owner-expired-${suffix}`,
    revisionScopeKey: `scope-expired-${suffix}`,
    traceIds: [`trace-expired-${suffix}`],
    nativeThreadId: `thread-${suffix}`,
    nativeTurnId: `turn-${suffix}`,
  };
  const actualNow = Date.now;
  let now = actualNow();
  let starts = 0;
  try {
    Date.now = () => now;
    await runStructuredCompactionOnce(key, owner, async () => {
      starts += 1;
      return "completed checkpoint";
    });
    await Bun.sleep(0);
    now += 31 * 60_000;
    await expect(runStructuredCompactionOnce(key, owner, async () => {
      starts += 1;
      return "duplicate checkpoint";
    })).rejects.toMatchObject({ code: "checkpoint_result_unavailable" });
    expect(starts).toBe(1);
  } finally {
    Date.now = actualNow;
  }
});

test("adapter rejects a changed native compact payload before a second browser submission", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compact-revision-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-revision-${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const firstRequest = request(true);
  const revisedRequest = structuredClone(firstRequest);
  (revisedRequest._rawBody as { input: unknown[] }).input.push({
    type: "function_call_output",
    call_id: "call_later",
    output: "An additional result arrived",
  });
  expect(chatGptTurnExecutionKey(firstRequest)).not.toBe(chatGptTurnExecutionKey(revisedRequest));
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let release!: (value: string) => void;
  const browser = new Promise<string>(resolve => { release = resolve; });
  let starts = 0;
  worker.run = async () => {
    starts += 1;
    return browser;
  };
  const adapter = createChatGptWebAdapter(provider);
  const firstEvents: AdapterEvent[] = [];
  const secondEvents: AdapterEvent[] = [];
  let firstTurn: Promise<void> | undefined;
  let secondTurn: Promise<void> | undefined;
  try {
    firstTurn = adapter.runTurn!(firstRequest, { headers: new Headers() }, event => firstEvents.push(event));
    for (let index = 0; index < 50 && starts === 0; index += 1) await Bun.sleep(1);
    expect(starts).toBe(1);
    secondTurn = adapter.runTurn!(revisedRequest, { headers: new Headers() }, event => secondEvents.push(event));
    const outcome = await Promise.race([
      secondTurn.then(() => "settled"),
      Bun.sleep(50).then(() => "pending"),
    ]);
    expect(outcome).toBe("settled");
    expect(secondEvents.some(event => event.type === "error"
      && event.code === "compaction_revision_conflict")).toBeTrue();
    expect(starts).toBe(1);
  } finally {
    release(missionCheckpoint("First checkpoint"));
    await firstTurn;
    await secondTurn;
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter keeps one compact epoch when native Codex changes reasoning effort", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compact-effort-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-effort-${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const firstRequest = request(true);
  const revisedRequest = structuredClone(firstRequest);
  revisedRequest.options.reasoning = "medium";
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let release!: (value: string) => void;
  const browser = new Promise<string>(resolve => { release = resolve; });
  let starts = 0;
  worker.run = async () => {
    starts += 1;
    return browser;
  };
  const adapter = createChatGptWebAdapter(provider);
  const firstEvents: AdapterEvent[] = [];
  const secondEvents: AdapterEvent[] = [];
  let firstTurn: Promise<void> | undefined;
  let secondTurn: Promise<void> | undefined;
  try {
    firstTurn = adapter.runTurn!(firstRequest, { headers: new Headers() }, event => firstEvents.push(event));
    for (let index = 0; index < 50 && starts === 0; index += 1) await Bun.sleep(1);
    expect(starts).toBe(1);
    secondTurn = adapter.runTurn!(revisedRequest, { headers: new Headers() }, event => secondEvents.push(event));
    const outcome = await Promise.race([
      secondTurn.then(() => "settled"),
      Bun.sleep(50).then(() => "pending"),
    ]);
    expect(outcome).toBe("settled");
    expect(secondEvents.some(event => event.type === "error"
      && event.code === "compaction_revision_conflict")).toBeTrue();
    expect(starts).toBe(1);
  } finally {
    release(missionCheckpoint("First checkpoint"));
    await firstTurn;
    await secondTurn;
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter keeps one native compact epoch across a provider configuration refresh", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compact-provider-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-provider-${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      experimentalFreshConversationPerTurn: true,
    },
  };
  const refreshed: CodexProviderConfig = {
    ...provider,
    chatgptWeb: { ...provider.chatgptWeb!, turnTimeoutMs: 240_000 },
  };
  expect(chatGptWebExecutionNamespace(provider)).not.toBe(chatGptWebExecutionNamespace(refreshed));
  const firstWorker = ChatGptBrowserWorker.forProvider(provider);
  const secondWorker = ChatGptBrowserWorker.forProvider(refreshed);
  const firstRun = firstWorker.run;
  const secondRun = secondWorker.run;
  let release!: (value: string) => void;
  const browser = new Promise<string>(resolve => { release = resolve; });
  let starts = 0;
  firstWorker.run = async () => {
    starts += 1;
    return browser;
  };
  secondWorker.run = async () => {
    starts += 1;
    return missionCheckpoint("Duplicate provider checkpoint");
  };
  const compact = request(true);
  const firstEvents: AdapterEvent[] = [];
  const secondEvents: AdapterEvent[] = [];
  let firstTurn: Promise<void> | undefined;
  let secondTurn: Promise<void> | undefined;
  try {
    firstTurn = createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => firstEvents.push(event));
    for (let index = 0; index < 50 && starts === 0; index += 1) await Bun.sleep(1);
    expect(starts).toBe(1);
    secondTurn = createChatGptWebAdapter(refreshed).runTurn!(compact, { headers: new Headers() }, event => secondEvents.push(event));
    const outcome = await Promise.race([
      secondTurn.then(() => "settled"),
      Bun.sleep(50).then(() => "pending"),
    ]);
    expect(outcome).toBe("settled");
    expect(secondEvents.some(event => event.type === "error"
      && event.code === "compaction_revision_conflict")).toBeTrue();
    expect(starts).toBe(1);
  } finally {
    release(missionCheckpoint("First provider checkpoint"));
    await firstTurn;
    await secondTurn;
    firstWorker.run = firstRun;
    secondWorker.run = secondRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed compact request retains its replay and owner gate until browser cleanup", async () => {
  const key = `failed-cleanup-${Date.now()}-${Math.random()}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] };
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let starts = 0;
  const first = runStructuredCompactionOnce(key, owner, async (_signal, retainOwnershipUntil) => {
    starts += 1;
    retainOwnershipUntil(physicalSettlement);
    throw new Error("checkpoint repair failed");
  });
  try {
    await expect(first).rejects.toThrow("checkpoint repair failed");
    const replay = runStructuredCompactionOnce(key, owner, async () => {
      starts += 1;
      return "must not rerun the failed request";
    });
    expect(replay).toBe(first);
    await expect(replay).rejects.toThrow("checkpoint repair failed");

    const next = runStructuredCompactionOnce(`${key}-next`, owner, async () => {
      starts += 1;
      return "next native turn";
    });
    await Bun.sleep(0);
    expect(starts).toBe(1);
    releasePhysical();
    await expect(next).resolves.toBe("next native turn");
    expect(starts).toBe(2);
  } finally {
    releasePhysical();
  }
});

test("an explicit trace cancellation clears a settled failed compaction for operator retry", async () => {
  const key = `failed-operator-retry-${Date.now()}-${Math.random()}`;
  const traceId = `trace-${key}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [traceId] };
  let starts = 0;
  await expect(runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    throw new Error("checkpoint repair failed");
  })).rejects.toThrow("checkpoint repair failed");
  await Bun.sleep(0);

  expect(await cancelStructuredCompactionTrace(traceId, new Error("operator requested retry"))).toBe(0);
  await expect(runStructuredCompactionOnce(key, owner, async () => {
    starts += 1;
    return "operator retry checkpoint";
  })).resolves.toBe("operator retry checkpoint");
  expect(starts).toBe(2);
});

test("a long compact run remains replayable for 30 minutes after physical settlement", async () => {
  const key = `long-compact-replay-${Date.now()}-${Math.random()}`;
  const owner = { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] };
  const actualNow = Date.now;
  let now = actualNow();
  let finish!: (summary: string) => void;
  const browser = new Promise<string>(resolve => { finish = resolve; });
  let starts = 0;
  try {
    Date.now = () => now;
    const first = runStructuredCompactionOnce(key, owner, async () => {
      starts += 1;
      return browser;
    });
    now += 31 * 60_000;
    finish("checkpoint from a long browser run");
    await expect(first).resolves.toBe("checkpoint from a long browser run");
    await Bun.sleep(0);

    const replay = runStructuredCompactionOnce(key, owner, async () => {
      starts += 1;
      return "must not rerun";
    });
    expect(replay).toBe(first);
    expect(starts).toBe(1);
  } finally {
    Date.now = actualNow;
    finish("cleanup");
  }
});

test("operator cancellation aborts the shared structured compaction owner", async () => {
  const key = `operator-cancel-${Date.now()}-${Math.random()}`;
  const traceId = `trace-${key}`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [traceId] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );
  await Bun.sleep(0);
  expect(await cancelStructuredCompactionTrace(traceId, new Error("operator cancelled"))).toBe(1);
  await expect(run).rejects.toThrow("operator cancelled");
  expect(aborted).toBeTrue();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();
});

test("native interruption before registration prevents the detached compaction from starting", async () => {
  const key = `interrupt-before-registration-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const reason = new DOMException("Codex turn interrupted", "AbortError");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    reason,
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;
  const duplicateCancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new Error("duplicate interrupt must not replace the first reason"),
  );
  expect(duplicateCancellation.cancelled).toBe(0);
  await duplicateCancellation.settlement;
  const unrelatedSettlements: Promise<void>[] = [];
  for (let index = 0; index < 1_025; index += 1) {
    const unrelated = cancelStructuredCompactionNativeTurn(
      `thread-unrelated-${key}-${index}`,
      `turn-unrelated-${key}-${index}`,
      new Error(`unrelated interrupt ${index}`),
    );
    unrelatedSettlements.push(unrelated.settlement);
  }
  await Promise.all(unrelatedSettlements);

  let started = false;
  const run = runStructuredCompactionOnce(key, owner, async () => {
    started = true;
    return "must not start";
  });

  await expect(run).rejects.toBe(reason);
  expect(started).toBeFalse();
  expect(existingStructuredCompactionRun(key)).toBeUndefined();

  let unrelatedStarted = false;
  await expect(runStructuredCompactionOnce(
    `${key}-unrelated`,
    {
      ...owner,
      ownerKey: `${owner.ownerKey}-unrelated`,
      nativeTurnId: `${owner.nativeTurnId}-unrelated`,
    },
    async () => {
      unrelatedStarted = true;
      return "unrelated checkpoint";
    },
  )).resolves.toBe("unrelated checkpoint");
  expect(unrelatedStarted).toBeTrue();
});

test("a completed exact compaction remains replayable after a later native interruption", async () => {
  const key = `completed-before-interrupt-${Date.now()}-${Math.random()}`;
  const owner = {
    ownerKey: `owner-${key}`,
    traceIds: [`trace-${key}`],
    nativeThreadId: `thread-${key}`,
    nativeTurnId: `turn-${key}`,
  };
  const completed = runStructuredCompactionOnce(key, owner, async () => "canonical checkpoint");
  await expect(completed).resolves.toBe("canonical checkpoint");

  const cancellation = cancelStructuredCompactionNativeTurn(
    owner.nativeThreadId,
    owner.nativeTurnId,
    new DOMException("Codex turn interrupted", "AbortError"),
  );
  expect(cancellation.cancelled).toBe(0);
  await cancellation.settlement;

  let restarted = false;
  const replay = runStructuredCompactionOnce(key, owner, async () => {
    restarted = true;
    return "must not replace canonical checkpoint";
  });
  expect(replay).toBe(completed);
  await expect(replay).resolves.toBe("canonical checkpoint");
  expect(restarted).toBeFalse();
});

test("a duplicate native interruption refreshes its lifetime without replacing its reason", async () => {
  const originalNow = Date.now;
  const key = `duplicate-interrupt-refresh-${originalNow()}-${Math.random()}`;
  const initialNow = 1_000_000_000;
  let now = initialNow;
  Date.now = () => now;
  try {
    const owner = {
      ownerKey: `owner-${key}`,
      traceIds: [`trace-${key}`],
      nativeThreadId: `thread-${key}`,
      nativeTurnId: `turn-${key}`,
    };
    const originalReason = new DOMException("first Codex turn interruption", "AbortError");
    cancelStructuredCompactionNativeTurn(owner.nativeThreadId, owner.nativeTurnId, originalReason);

    now = initialNow + (29 * 60_000) + 59_000;
    cancelStructuredCompactionNativeTurn(
      owner.nativeThreadId,
      owner.nativeTurnId,
      new Error("duplicate reason must not become authoritative"),
    );

    now = initialNow + (30 * 60_000) + 1_000;
    let started = false;
    const run = runStructuredCompactionOnce(key, owner, async () => {
      started = true;
      return "must not start";
    });
    await expect(run).rejects.toBe(originalReason);
    expect(started).toBeFalse();
  } finally {
    Date.now = originalNow;
  }
});

test("structured compaction rejects incomplete native interruption identities", () => {
  const reason = new DOMException("Codex turn interrupted", "AbortError");
  expect(() => cancelStructuredCompactionNativeTurn(" ", "turn_valid", reason))
    .toThrow("non-empty native thread and turn ids");
  expect(() => runStructuredCompactionOnce(
    `incomplete-native-owner-${Date.now()}-${Math.random()}`,
    { ownerKey: "incomplete-native-owner", traceIds: [], nativeThreadId: "thread_valid" },
    async () => "must not start",
  )).toThrow("non-empty native thread and turn ids");
});

test("active compaction settles canonical tool results before the separate retained handoff", async () => {
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  const compactionTokens: string[] = [];
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  const broker = {
    requestCompaction: (token: string) => { compactionTokens.push(token); return 0; },
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
      if (callId === "call_two") {
        finishBrowser("Ordinary final after canonical results.");
      }
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active"),
    externalProgress: {
      recordToolResult() {},
    } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false },
    { callId: "call_two", wireName: "exec_command", freeform: false },
  ]);
  const parsed = request(true);
  parsed.context.messages.push(
    { role: "toolResult", toolCallId: "call_one", toolName: "exec_command", content: "one", isError: false, timestamp: 4 },
    { role: "toolResult", toolCallId: "call_two", toolName: "exec_command", content: "two", isError: false, timestamp: 5 },
  );

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Ordinary final after canonical results.",
    compactionInstructionDelivered: false,
  });
  expect(compactionTokens).toEqual(["turn_active"]);
  expect(completed.map(entry => entry.callId)).toEqual(["call_one", "call_two"]);
  expect(JSON.stringify(completed[0])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).not.toContain("codex.control.compaction_handoff");
  expect(completed[1]!.result.content).toEqual([{ type: "text", text: "two" }]);
});

test("active compaction distinguishes a later intercepted tool from an ordinary post-result final", async () => {
  let finishBrowser!: (answer: string) => void;
  const browser = new Promise<string>(resolve => { finishBrowser = resolve; });
  let compactionDeliveries = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => compactionDeliveries,
    completeTool: async (_token: string, _callId: string, result: BrokerToolResult) => {
      expect(result.content).toEqual([{ type: "text", text: "canonical result" }]);
      compactionDeliveries = 1;
      finishBrowser("Stopped after the bridge rejected a later tool call.");
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active_later_tool"),
    externalProgress: { recordToolResult() {} } as never,
    browser,
    physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([{
    callId: "call_current",
    wireName: "exec_command",
    freeform: false,
  }]);
  const parsed = request(true);
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: "call_current",
    toolName: "exec_command",
    content: "canonical result",
    isError: false,
    timestamp: 4,
  });

  await expect(settleActiveCompactionSource(parsed, source, broker)).resolves.toEqual({
    answer: "Stopped after the bridge rejected a later tool call.",
    compactionInstructionDelivered: true,
  });
});

test("active compaction waits for an ordinary response with no available tool boundary", async () => {
  const browser = Promise.resolve("The ordinary response reached its terminal boundary.");
  let requested = 0;
  const broker = {
    requestCompaction: () => { requested += 1; return 0; },
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_without_boundary"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(), cancel() {},
  });
  await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
    answer: "The ordinary response reached its terminal boundary.",
    compactionInstructionDelivered: false,
  });
  expect(requested).toBe(1);
});

test("active compaction aborts its source when the shared handoff deadline expires", async () => {
  const controller = new AbortController();
  const deadlineError = new Error("shared compaction deadline expired");
  const browser = new Promise<string>(() => {});
  let cancellations = 0;
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool() { throw new Error("no tool result should be delivered"); },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools", token: Promise.resolve("turn_active_deadline"),
    externalProgress: { recordToolResult() {} } as never,
    browser, physicalSettlement: browser.then(() => undefined),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  });
  setTimeout(() => controller.abort(deadlineError), 10);

  await expect(settleActiveCompactionSource(
    request(true),
    source,
    broker,
    controller.signal,
  )).rejects.toThrow("shared compaction deadline expired");
  expect(cancellations).toBe(1);
});

test("Zero Risk active compaction returns through its explicit completion control", async () => {
  const completed: BrokerToolResult[] = [];
  const broker = {
    requestCompaction: () => 0,
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, _callId: string, result: BrokerToolResult) => {
      completed.push(result);
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active_zero_risk"),
    externalProgress: { recordToolResult() {} } as never,
    manualControl: { surfaceNonce: "n".repeat(24) },
    browser: Promise.resolve("Zero Risk checkpoint"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([{ callId: "call_one", wireName: "exec_command", freeform: false }]);
  const parsed = request(true);
  parsed.context.messages.push({
    role: "toolResult",
    toolCallId: "call_one",
    toolName: "exec_command",
    content: "one",
    isError: false,
    timestamp: 4,
  });

  await expect(settleActiveZeroRiskCompactionSource(parsed, source, broker))
    .resolves.toBe("Zero Risk checkpoint");
  expect(JSON.stringify(completed)).toContain("Return only the complete checkpoint summary to Codex with codex_turn_complete");
  expect(JSON.stringify(completed)).not.toContain("CODEX_ACTIVE_COMPACTION_CHECKPOINT_");
});

test("active compaction interrupts a queued MCP call that Codex never started waiting for", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compaction-queued-call-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_queued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const queuedInvocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    const browser = queuedInvocation.then(result => {
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result.content)).toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
      expect(JSON.stringify(result.content)).toContain("The tool was not executed");
      expect(JSON.stringify(result.content)).not.toContain("codex.control.compaction_handoff");
      return "Stopped for the retained compaction handoff";
    });
    const source = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(token),
      externalProgress: {
        recordToolResult() {},
      } as never,
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      retireCapability: () => broker.revoke(token),
      cancel() {},
    });

    await expect(settleActiveCompactionSource(request(true), source, broker)).resolves.toEqual({
      answer: "Stopped for the retained compaction handoff",
      compactionInstructionDelivered: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later native message waits for the current response and its physical settlement without preempting it", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishClient!: (answer: string) => void;
  let settlePhysical!: () => void;
  const clientOutcome = new Promise<string>(resolve => { finishClient = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let cancellations = 0;
  sessions.getOrCreate("old", () => ({
    mode: "read-only",
    browser: clientOutcome,
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  }), "old_trace", "same_owner");
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "same_owner", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("new"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() {},
    };
  });

  await Bun.sleep(0);
  expect(starts).toBe(0);
  expect(cancellations).toBe(0);
  finishClient("old complete");
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
  sessions.clear();
});

test("a later native message still waits when logical completion happened before ownership lookup", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  const completed = sessions.getOrCreate("old-completed", () => ({
    mode: "read-only",
    browser: Promise.resolve("logical result"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  }), "old_trace", "same_owner_after_result");
  await completed.browserOutcome;

  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement(
    "new-after-result",
    "same_owner_after_result",
    () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("new"),
        physicalSettlement: Promise.resolve(),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel() {},
      };
    },
  );
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  sessions.clear();
});

test("retained conversation release waits for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let releases = 0;
  sessions.getOrCreate("retained", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "a".repeat(64),
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  const retirement = sessions.retireConversationAndWait("a".repeat(64));
  await Bun.sleep(0);
  expect(releases).toBe(0);
  settlePhysical();
  expect(await retirement).toBe(1);
  expect(releases).toBe(1);
});

test("a repeated compaction waits for the previous conversation retirement", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "c".repeat(64);
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  sessions.getOrCreate("retained-repeating", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => {},
    cancel() {},
  }));

  const retirement = sessions.retireConversationAndWait(conversationKey);
  let waited = false;
  const nextCompaction = sessions.waitForConversationRetirement(conversationKey).then(() => {
    waited = true;
  });
  await Bun.sleep(0);
  expect(waited).toBeFalse();
  settlePhysical();
  await retirement;
  await nextCompaction;
  expect(waited).toBeTrue();
});

test("retained compaction can close its browser epoch while preserving an ordinary final response", async () => {
  const sessions = new ChatGptTurnSessions();
  const conversationKey = "b".repeat(64);
  const text = new ChatGptTextFeed();
  text.push("ordinary final answer");
  let releases = 0;
  let replacementStarts = 0;
  const source = sessions.getOrCreate("ordinary-final", () => ({
    mode: "read-only",
    browser: Promise.resolve("ordinary final answer"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await source.browserOutcome;
  await source.physicalSettlement;

  expect(await sessions.retireConversationPreservingFinalResponse(
    conversationKey,
    source,
    "compacted-ordinary-final",
  )).toBe(1);
  expect(releases).toBe(1);
  expect(source.conversationKey()).toBeUndefined();
  expect(sessions.findConversationHead(conversationKey)).toBeUndefined();
  expect(sessions.find("ordinary-final")).toBeUndefined();
  expect(sessions.find("compacted-ordinary-final")).toBe(source);
  expect(sessions.getOrCreate("compacted-ordinary-final", () => {
    replacementStarts += 1;
    throw new Error("the committed final response must be replayed, not replaced");
  })).toBe(source);
  expect(replacementStarts).toBe(0);
  sessions.clear();
});

test("adapter compact returns one same-agent handoff and preserves a pre-existing ordinary final", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-adapter-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retained-compact-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    expect(turn.nativeConnector).toBeTrue();
    expect(turn.capabilities.localToolsEnabled).toBeFalse();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: missionCheckpoint("Adapter retained checkpoint"),
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const compactSourceMessage = (compact._rawBody as { input: Array<{
    content: Array<{ type: string; text: string }>;
  }> }).input[0]!;
  compactSourceMessage.content = [{
    type: "input_text",
    text: "Provider-normalized current task revision",
  }];
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: nativeThreadId(),
      turn_id: "turn_compact",
    }),
  };
  expect(chatGptConversationKey(compact, namespace)).toBe(conversationKey);
  const compactedSourceKey = `${namespace}:${chatGptCompactionSourceExecutionKey(compact)}`;
  expect(compactedSourceKey).not.toBe(sourceKey);
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    const text = events
      .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(text).toContain("Adapter retained checkpoint");
    expect(text).toContain("CODEX_LATEST_USER_PROMPT_JSON");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
    expect(chatGptTurnSessions.find(compactedSourceKey)).toBeDefined();
    expect(chatGptTurnSessions.find(compactedSourceKey)!.conversationKey()).toBeUndefined();
    expect(chatGptTurnSessions.findConversationHead(conversationKey)).toBeUndefined();
    expect(releases).toBe(1);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid checkpoint keeps the retained source and does not send a second prompt without repair time", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-invalid-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://invalid-checkpoint-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 1_000,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  let browserMessages = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "This checkpoint omits the mission checklist and cannot replace the source history.",
    });
    return "submitted";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
    expect(browserMessages).toBe(1);
    expect(releases).toBe(0);
    expect(chatGptTurnSessions.findConversationHead(conversationKey)).toBeDefined();
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty retained handoff is repaired once before replacing its source", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-retained-empty-repair-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retained-empty-repair-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;
  let browserMessages = 0;
  worker.run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: browserMessages === 1 ? "" : missionCheckpoint("Repaired retained checkpoint"),
    });
    return "submitted";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([true, false])("an invalid retained checkpoint gets one repair without losing source history (repair succeeds=%s)", async repaired => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-checkpoint-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  let browserMessages = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    if (browserMessages === 2) expect(prepared.text).toContain("Repair that draft once");
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: browserMessages === 1 || !repaired
        ? "Incomplete checkpoint without a mission checklist."
        : missionCheckpoint("Repaired retained checkpoint"),
    });
    return "submitted";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    expect(browserMessages).toBe(2);
    expect(releases).toBe(repaired ? 1 : 0);
    if (repaired) {
      expect(events.some(event => event.type === "text_delta" && event.text.includes("Repaired retained checkpoint"))).toBeTrue();
      expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
    } else {
      expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
      expect(chatGptTurnSessions.findConversationHead(conversationKey)).toBeDefined();
    }
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compact HTTP observer can reconnect without sending a second retained-chat message", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-compact-reconnect-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-reconnect-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserMessages = 0;
  let messageStarted!: () => void;
  const started = new Promise<void>(resolve => { messageStarted = resolve; });
  let finishMessage!: () => void;
  const finish = new Promise<void>(resolve => { finishMessage = resolve; });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    prepared.release();
    messageStarted();
    await finish;
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: missionCheckpoint("Reconnect-safe checkpoint"),
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: nativeThreadId(),
      turn_id: "turn_compact_reconnect",
    }),
  };
  const adapter = createChatGptWebAdapter(provider);
  const disconnect = new AbortController();
  try {
    const first = adapter.runTurn!(
      compact,
      { headers: new Headers(), abortSignal: disconnect.signal },
      () => {},
    );
    await started;
    disconnect.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const events: AdapterEvent[] = [];
    const reconnect = adapter.runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    finishMessage();
    await reconnect;
    expect(browserMessages).toBe(1);
    expect(releases).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Reconnect-safe checkpoint"))).toBeTrue();
    expect(events.filter(event => event.type === "milestone" && event.kind === "checkpoint_completed"))
      .toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("structured compact rebuilds canonical context when its retained source is absent (Bigger Context=%s)", async experimentalBiggerContext => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-missing-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://missing-retained-${Date.now()}`,
    chatgptWeb: {
      experimentalBiggerContext,
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    expect(turn.requireRetainedConversation).toBeUndefined();
    expect(turn.conversationKey).toBeUndefined();
    expect(turn.compaction).toBeTrue();
    const prepared = await turn.prepare();
    const contextText = prepared.multipart?.parts.join("\n") ?? prepared.text;
    expect(contextText).toContain("Original task");
    expect(contextText).toContain("Continue with the next step");
    expect(prepared.multipart!.parts).toHaveLength(6);
    expect(prepared.trimmedCompactionMessages).toBeUndefined();
    const lastRecord = prepared.multipart!.parts.flatMap(part => JSON.parse(part).records).at(-1);
    expect(lastRecord.message.content).toBe(compact.context.messages.at(-1)!.content);
    prepared.release();
    return missionCheckpoint("Fallback checkpoint from canonical Codex context");
  };
  const compact = request(true);
  const events: AdapterEvent[] = [];
  compact.context.messages.at(-1)!.content += "x".repeat(160_000);
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint from canonical Codex context"))).toBeTrue();
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("CODEX_LATEST_USER_PROMPT_JSON"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 20_000 });

test.each([false, true])("configured fresh compaction waits for cleanup and preserves committed final=%s", async committed => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-fresh-owner-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web", baseUrl: `browser://fresh-owner-${root}`,
    chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root), localToolsEnabled: true, solAvailable: true,
      experimentalFreshConversationPerTurn: true },
  };
  const compact = request(true);
  const sourceKey = `${chatGptWebExecutionNamespace(provider)}:${chatGptCompactionSourceExecutionKey(compact)}`;
  let finishSource!: (answer: string) => void;
  let releaseSource!: () => void;
  let cancelled = false;
  const cleanup = new Promise<void>(resolve => { releaseSource = resolve; });
  const source = chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only", browser: new Promise<string>(resolve => { finishSource = resolve; }),
    physicalSettlement: cleanup, trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; finishSource("retired source"); },
  }));
  if (committed) {
    finishSource("committed final");
    await source.browserOutcome;
  }
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  let starts = 0;
  worker.run = async () => { starts += 1; return missionCheckpoint("Fresh checkpoint"); };
  const events: AdapterEvent[] = [];
  let pending: Promise<void> | undefined;
  try {
    pending = createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, event => events.push(event));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cancelled).toBe(!committed);
    expect(starts).toBe(0);
    releaseSource();
    await pending;
    expect(starts).toBe(1);
    expect(chatGptTurnSessions.find(sourceKey)).toBe(committed ? source : undefined);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    finishSource("cleanup");
    releaseSource();
    await pending;
    worker.run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("fresh multipart compaction preserves phase budgets with fresh mode=%s", async freshConversation => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-phased-fallback-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://phased-fallback-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 40,
      experimentalFreshConversationPerTurn: freshConversation,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.traceId.endsWith(freshConversation ? "_fresh" : "_fallback")).toBeTrue();
    expect(turn.onMultipartStageAcknowledged).toBeDefined();
    expect(turn.onSubmitted).toBeDefined();
    for (let part = 1; part <= 5; part++) {
      mock?.timers?.tick?.(25);
      expect(turn.abortSignal?.aborted).toBeFalse();
      await turn.onMultipartStageAcknowledged!(part);
    }
    mock?.timers?.tick?.(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    turn.onSubmitted!();
    mock?.timers?.tick?.(25);
    expect(turn.abortSignal?.aborted).toBeFalse();
    return missionCheckpoint("Fallback checkpoint after separately bounded phases");
  };
  const events: AdapterEvent[] = [];
  mock?.timers?.enable?.({ apis: ["setTimeout"] });
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after separately bounded phases"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    mock?.timers?.reset?.();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed fresh fallback is rejected without a second original-history submission", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-invalid-fresh-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://invalid-fresh-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 1_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return "Narrative only; the mission checklist was omitted.";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
    expect(browserMessages).toBe(1);
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid fresh fallback receives one bounded draft repair, not a replay of the original history", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-fresh-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-fresh-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const draft = "Narrative only; the mission checklist was omitted.";
  const compact = request(true);
  compact.context.messages[0] = {
    role: "user",
    content: [
      { type: "text", text: "Original task" },
      { type: "image", imageUrl: "data:image/png;base64,SHOULD_NOT_COPY", detail: "high" },
    ],
    timestamp: 1,
  };
  compact.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: 4 });
  let browserMessages = 0;
  let repairPrompt = "";
  worker.run = async turn => {
    browserMessages += 1;
    if (browserMessages === 1) return draft;
    const prepared = await turn.prepare();
    repairPrompt = prepared.text;
    prepared.release();
    return missionCheckpoint("Repaired fresh checkpoint");
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(2);
    expect(repairPrompt).toContain(draft);
    expect(repairPrompt).toContain("Missing structured compaction state");
    expect(repairPrompt).not.toContain("Work completed");
    expect(repairPrompt).not.toContain("SHOULD_NOT_COPY");
    expect(repairPrompt).toContain("Latest user request:\\n\\\"Continue with the next step\\\"");
    expect(repairPrompt).toContain("version: 2");
    expect(repairPrompt).toContain("original_request_ref:");
    expect(repairPrompt).toContain("requirements:");
    expect(repairPrompt).toContain("blockers_or_test_failures:");
    expect(repairPrompt).toContain("next_actions:");
    const repairContext = JSON.parse(repairPrompt.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)![1]!) as {
      messages: Array<{ content: string }>;
    };
    expect(repairContext.messages[0]!.content.trimEnd()).toEndWith(
      "Return only the complete checkpoint block. No preface, narrative summary, Markdown fence, or trailing text.",
    );
    expect(repairContext.messages[0]!.content).toContain("do not wrap them in Markdown code fences");
    expect(repairContext.messages[0]!.content).toContain(
      "Begin your answer with a literal <compaction_state> line and end it with a literal </compaction_state> line.",
    );
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Repaired fresh checkpoint"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid fresh repair is rejected after exactly one correction attempt", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-fresh-rejected-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-fresh-rejected-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return browserMessages === 1
      ? "Incomplete checkpoint without a mission checklist."
      : "version: 2\nrequirements:\n- pending requirement\nnext_actions:\n- Continue\n</compaction_state>";
  };
  const events: AdapterEvent[] = [];
  const logs: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
    const repairedValidation = logs.find(line => line.startsWith("[chatgpt-web] checkpoint_validation ")
      && line.includes('"repaired":true'));
    expect(repairedValidation).toBeDefined();
    expect(JSON.parse(repairedValidation!.slice("[chatgpt-web] checkpoint_validation ".length)))
      .toMatchObject({ valid: false, missingState: true, openingTags: 0, closingTags: 1 });
  } finally {
    logger.mockRestore();
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed fresh repair cannot trigger another original-history submission for the same compact request", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-fresh-failure-replay-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-fresh-failure-replay-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    if (browserMessages === 1) return "Incomplete checkpoint without a mission checklist.";
    throw new ChatGptWebAdapterError("ChatGPT final DOM could not be aligned with text already streamed to Codex", {
      status: 502,
      errorType: "server_error",
      code: "browser_stream_inconsistent",
      retryable: false,
    });
  };
  const compact = request(true);
  const adapter = createChatGptWebAdapter(provider);
  const firstEvents: AdapterEvent[] = [];
  const replayEvents: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(compact, { headers: new Headers() }, event => firstEvents.push(event));
    expect(browserMessages).toBe(2);
    expect(firstEvents.at(-1)).toMatchObject({ type: "error", code: "browser_stream_inconsistent" });

    await Bun.sleep(0);
    await adapter.runTurn!(compact, { headers: new Headers() }, event => replayEvents.push(event));
    expect(browserMessages).toBe(2);
    expect(replayEvents.at(-1)).toMatchObject({ type: "error", code: "browser_stream_inconsistent" });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty fresh checkpoint receives one repair when the deadline permits", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-empty-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-empty-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return browserMessages === 1 ? "  \n  " : missionCheckpoint("Recovered empty checkpoint");
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty fresh checkpoint without repair time preserves history and reports validation failure", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-empty-no-time-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-empty-no-time-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 1_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return "";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint format telemetry describes the generated draft, not tags in the original request", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-checkpoint-format-log-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://checkpoint-format-log-${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 1_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run;
  const logs: string[] = [];
  const logger = spyOn(console, "info").mockImplementation((...args) => {
    logs.push(args.join(" "));
  });
  const compact = request(true);
  compact.context.messages[0]!.content = "Investigate <compaction_state> and </compaction_state> tags";
  worker.run = async () => "ChatGPT returned only a narrative about the ongoing investigation and no mission checklist.";
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    const validation = logs.find(line => line.startsWith("[chatgpt-web] checkpoint_validation "));
    expect(validation).toBeDefined();
    const shape = JSON.parse(validation!.slice("[chatgpt-web] checkpoint_validation ".length));
    expect(shape).toMatchObject({
      valid: false,
      missingState: true,
      openingTags: 0,
      closingTags: 0,
      usableUnfencedBlock: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
  } finally {
    logger.mockRestore();
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh repair uses compiled multipart capacity beyond the raw Instant composer boundary", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-compiled-budget-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-compiled-budget-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const compact = request(true);
  compact.options.reasoning = "low";
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return browserMessages === 1 ? "A".repeat(560_000) : missionCheckpoint("Repaired large draft");
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", endTurn: true });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 20_000 });

test("fresh repair keeps the original history when its compiled payload cannot fit", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-compiled-reject-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-compiled-reject-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      experimentalBiggerContext: false,
      turnTimeoutMs: 130_000,
    },
  };
  const compact = request(true);
  compact.options.reasoning = "low";
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  worker.run = async () => {
    browserMessages += 1;
    return "A".repeat(300_000);
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserMessages).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_checkpoint_validation_failed" });
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 20_000 });

test("fresh repair after a prior checkpoint retains original request and prior mission state", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-prior-checkpoint-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-prior-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const prior = canonicalizeCompactionHandoff(request(true), missionCheckpoint("Prior checkpoint")
    .replace("modified_files:\n", "modified_files:\n- src/important.ts\n")
    .replace("decisions_and_invariants:\n", "decisions_and_invariants:\n- Never resend an accepted prompt\n")
    .replace("blockers_or_test_failures:\n- None", "blockers_or_test_failures:\n- Network test failed"));
  const compact = request(true);
  compact.context.messages = [
    { role: "user", origin: "compaction_summary", content: prior, timestamp: 4 },
    { role: "user", content: "Keep the approval constraint", timestamp: 5 },
    { role: "user", content: "New requirement after checkpoint", timestamp: 6 },
    { role: "assistant", content: [{
      type: "toolCall",
      id: "call_verified_test",
      name: "exec_command",
      arguments: { cmd: "bun test tests/bridge.test.ts" },
    }], timestamp: 6 },
    { role: "toolResult", toolCallId: "call_verified_test", toolName: "exec_command",
      content: '{"exit_code":0,"output":"bun test tests/bridge.test.ts: 2 pass"}',
      isError: false, timestamp: 6 },
    { role: "user", content: COMPACT_PROMPT, timestamp: 7 },
  ];
  const raw = compact._rawBody as { input: Array<{ content: Array<{ text: string }> }> };
  raw.input[0]!.content[0]!.text = "New requirement after checkpoint";
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let repairPrompt = "";
  let browserMessages = 0;
  worker.run = async turn => {
    browserMessages += 1;
    if (browserMessages === 1) return "Draft omitted the mission checklist.";
    const prepared = await turn.prepare();
    repairPrompt = prepared.text;
    prepared.release();
    return "Still incomplete.";
  };
  try {
    await createChatGptWebAdapter(provider).runTurn!(compact, { headers: new Headers() }, () => {});
    expect(browserMessages).toBe(2);
    expect(repairPrompt).toContain("Original task");
    expect(repairPrompt).toContain("New requirement after checkpoint");
    expect(repairPrompt).toContain("Keep the approval constraint");
    expect(repairPrompt).toContain("src/important.ts");
    expect(repairPrompt).toContain("Never resend an accepted prompt");
    expect(repairPrompt).toContain("Network test failed");
    expect(repairPrompt).toContain("bun test tests/bridge.test.ts: 2 pass");
    expect(repairPrompt).toContain("call_verified_test");
    expect(repairPrompt).not.toContain("STRUCTURED HANDOFF REQUIREMENT");
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a fresh repair revokes its turn and prevents a third submission", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-repair-fresh-cancel-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://repair-fresh-cancel-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      turnTimeoutMs: 130_000,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserMessages = 0;
  let repairStarted!: (traceId: string) => void;
  const repairTrace = new Promise<string>(resolve => { repairStarted = resolve; });
  let repairAborted = false;
  worker.run = async turn => {
    browserMessages += 1;
    if (browserMessages === 1) return "Incomplete checkpoint without a mission checklist.";
    repairStarted(turn.traceId);
    return new Promise<string>((_resolve, reject) => {
      turn.abortSignal?.addEventListener("abort", () => {
        repairAborted = true;
        reject(turn.abortSignal?.reason);
      }, { once: true });
    });
  };
  const events: AdapterEvent[] = [];
  try {
    const run = createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    const traceId = await repairTrace;
    expect(await cancelStructuredCompactionTrace(traceId, new Error("operator cancelled repair"))).toBe(1);
    await run;
    expect(repairAborted).toBeTrue();
    expect(browserMessages).toBe(2);
    expect(events.at(-1)?.type).toBe("error");
  } finally {
    worker.run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancel-all waits for physical settlement of a fresh compaction fallback", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-cancel-fresh-compaction-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://cancel-fresh-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let fallbackStarted!: () => void;
  const fallbackReady = new Promise<void>(resolve => { fallbackStarted = resolve; });
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let cancelObserved = false;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    expect(turn.requireRetainedConversation).toBeUndefined();
    fallbackStarted();
    turn.abortSignal?.addEventListener("abort", () => { cancelObserved = true; }, { once: true });
    await physicalSettlement;
    return "cancelled fallback";
  };

  const adapterRun = createChatGptWebAdapter(provider).runTurn!(
    request(true),
    { headers: new Headers() },
    () => {},
  );
  try {
    await fallbackReady;
    const cancellation = cancelAllStructuredCompactions(new Error("operator cancelled"));
    let cancellationSettled = false;
    void cancellation.then(() => { cancellationSettled = true; });
    await Bun.sleep(10);
    expect(cancelObserved).toBeTrue();
    expect(cancellationSettled).toBeFalse();
    releasePhysical();
    await expect(cancellation).resolves.toBe(1);
    await adapterRun;
  } finally {
    releasePhysical();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out fresh compaction retains its owner until helper cleanup completes", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-timeout-cleanup-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://timeout-cleanup-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 40,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let releasePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { releasePhysical = resolve; });
  let browserStarts = 0;
  let cancelled = false;
  let fallbackTrace = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    fallbackTrace = turn.traceId;
    started();
    turn.abortSignal!.addEventListener("abort", () => { cancelled = true; }, { once: true });
    await physicalSettlement;
    return missionCheckpoint("Browser released after cancellation");
  };
  const adapter = createChatGptWebAdapter(provider);
  const events: AdapterEvent[] = [];
  const runs: Promise<void>[] = [];
  const observe = () => {
    const run = adapter.runTurn!(request(true), { headers: new Headers() }, event => events.push(event));
    runs.push(run);
    return run;
  };
  mock?.timers?.enable?.({ apis: ["setTimeout"] });
  try {
    void observe();
    await ready;
    mock?.timers?.tick?.(41);
    await Bun.sleep(50);
    expect(cancelled).toBeTrue();
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
    await observe();
    let cleanupSettled = false;
    const cleanup = cancelStructuredCompactionTrace(fallbackTrace, new Error("wait for timeout cleanup"))
      .then(count => { cleanupSettled = true; return count; });
    await Bun.sleep(5);
    expect(browserStarts).toBe(1);
    expect(cleanupSettled).toBeFalse();
    releasePhysical();
    expect(await cleanup).toBe(1);
    await Promise.all(runs);
    expect(events.filter(event => event.type === "error")).toHaveLength(2);
    expect(events.some(event => event.type === "done")).toBeFalse();
    await observe();
    expect(browserStarts).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    releasePhysical();
    await Promise.allSettled(runs);
    mock?.timers?.reset?.();
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])("structured compact rebuild after retained browser loss preserves rate limit=%s", async rateLimited => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
    const prepared = await turn.prepare();
    expect(prepared.text).toContain("Original task");
    prepared.release();
    if (rateLimited) throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests.", {
      status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false,
    });
    return missionCheckpoint("Fallback checkpoint after retained browser loss");
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(2);
    if (rateLimited) {
      expect(events.at(-1)).toMatchObject({
        type: "error", status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded",
        retryable: false, message: "ChatGPT rate limit: too many requests.",
      });
      expect(events.some(event => event.type === "done")).toBeFalse();
      return;
    }
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after retained browser loss"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a disappeared retained source cannot leave its fresh compaction rebuild past the shared deadline", async () => {
  const root = mkdtempSync(join(shortSocketTempRoot(), "cgw-stale-retained-deadline-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-deadline-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      turnTimeoutMs: 25,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  let releaseBrowser: (() => void) | undefined;
  let fallbackTrace = "";
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
    fallbackTrace = turn.traceId;
    return new Promise<string>(resolve => { releaseBrowser = () => resolve("browser cleanup completed"); });
  };
  const events: AdapterEvent[] = [];
  const startedAt = performance.now();
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(browserStarts).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "compaction_handoff_timeout",
      retryable: false,
      message: "ChatGPT compaction did not fully settle within 25ms",
    });
  } finally {
    releaseBrowser?.();
    await cancelStructuredCompactionTrace(fallbackTrace, new Error("test cleanup"));
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
