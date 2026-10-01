import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { compactionOriginalRequestRef } from "../src/adapters/chatgpt-web/compaction-source";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import {
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptThreadOwnershipKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { formatCompactionStateBlock, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function nativeRequest(turnId = "phase-1", threadId = "mission-1"): CodexParsedRequest {
  return parseRequest({
    model: "gpt-5.6-sol",
    input: [
      {
        type: "message",
        role: "developer",
        content: "Never deploy without explicit authorization.",
      },
      {
        type: "message",
        role: "user",
        content: "Fix the parser and verify the regression. Preserve quoted strings.",
        internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
      },
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
}

function draft(parsed: CodexParsedRequest): string {
  return formatCompactionStateBlock({
    version: 2,
    originalRequestRef: compactionOriginalRequestRef(parsed),
    modifiedFiles: [],
    activeHypothesis: "Inspect parser handling of quoted strings.",
    requirements: [
      {
        id: "REQ-parser",
        status: "pending",
        source: "Fix the parser and verify the regression. Preserve quoted strings.",
      },
    ],
    closureCriteria: ["The parser regression passes."],
    verifiedAchievements: [],
    decisionsAndInvariants: ["Never deploy without explicit authorization."],
    blockersOrTestFailures: [],
    pendingObligations: ["Verify the parser regression."],
    nextActions: ["Inspect the quoted-string parser."],
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cgw-phase-"));
  roots.push(root);
  const path = join(root, "private", "journal.sqlite");
  let journal = new SessionActorJournal(path);
  const results = new SessionResultStore(join(root, "private", "results"));
  let manager = new SessionActorManager(journal, results);
  await manager.beginTurn("namespace:mission", "phase-1");
  await manager.runBrowserTurn("namespace:mission", "phase-1", "browser:phase-1", async (accepted) => {
    await accepted();
    return "Parser inspection complete.";
  });
  return {
    get manager() {
      return manager;
    },
    get journal() {
      return journal;
    },
    restart() {
      journal.close();
      journal = new SessionActorJournal(path);
      manager = new SessionActorManager(journal, results);
    },
    close() {
      journal.close();
    },
  };
}

function continuation(parsed: CodexParsedRequest, answer = "Parser inspection complete.") {
  const raw = parsed._rawBody as { input: unknown[]; client_metadata: { "x-codex-turn-metadata": string } };
  const metadata = JSON.parse(raw.client_metadata["x-codex-turn-metadata"]);
  return parseRequest({
    ...raw,
    model: parsed.modelId,
    input: [
      ...raw.input,
      {
        type: "message",
        role: "assistant",
        content: answer,
        internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
      },
      {
        type: "message",
        role: "user",
        content: "Continue with the tests.",
        internal_chat_message_metadata_passthrough: { turn_id: "phase-2" },
      },
    ],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: metadata.thread_id, turn_id: "phase-2" }) },
  });
}

test("a confirmed phase checkpoint survives restart and replaces only its exact parent history", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    const store = home.manager.phaseCheckpoints!;
    await store.commit("namespace:mission", 1, parsed, draft(parsed), "Parser inspection complete.");
    home.restart();
    const next = continuation(parsed);
    const replay = home.manager.phaseCheckpoints!.apply("namespace:mission", next);
    expect(replay.applied).toBe(true);
    expect(replay.parsed._rawBody).toBe(next._rawBody);
    expect(replay.parsed.context.messages[0]?.role).toBe("developer");
    expect(JSON.stringify(replay.parsed.context.messages)).toContain("Never deploy without explicit authorization.");
    expect(JSON.stringify(replay.parsed.context.messages)).toContain("Inspect the quoted-string parser.");
    expect(JSON.stringify(replay.parsed.context.messages)).toContain("Continue with the tests.");
    expect(home.manager.phaseCheckpoints!.apply("namespace:other", next).applied).toBe(false);
    const changedMode = structuredClone(next);
    changedMode._chatgptModelFamily = "6";
    expect(home.manager.phaseCheckpoints!.apply("namespace:mission", changedMode).applied).toBe(false);
    changedMode._chatgptModelFamily = undefined;
    changedMode.options.reasoning = "low";
    expect(home.manager.phaseCheckpoints!.apply("namespace:mission", changedMode).applied).toBe(false);
    expect(
      home.manager.phaseCheckpoints!.apply("namespace:mission", continuation(parsed, "Another answer")).applied,
    ).toBe(false);
  } finally {
    home.close();
  }
});

test("invalid or stale checkpoints cannot replace the last durable checkpoint", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    const store = home.manager.phaseCheckpoints!;
    await expect(store.commit("namespace:mission", 1, parsed, "No structured state", "Answer")).rejects.toThrow(
      "checkpoint",
    );
    expect(store.apply("namespace:mission", continuation(parsed)).applied).toBe(false);
    await store.commit("namespace:mission", 1, parsed, draft(parsed), "Parser inspection complete.");
    await expect(store.commit("namespace:mission", 2, parsed, draft(parsed), "Answer")).rejects.toThrow("ownership");
    expect(store.apply("namespace:mission", continuation(parsed)).applied).toBe(true);
    await expect(store.commit("namespace:mission", 1, parsed, draft(parsed), "Changed answer")).rejects.toThrow(
      "conflicting",
    );
  } finally {
    home.close();
  }
});

test("a checkpoint cannot hide changed history or omit a literal user requirement", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    const incomplete = draft(parsed).replace(
      "Fix the parser and verify the regression. Preserve quoted strings.",
      "Fix the parser",
    );
    await expect(
      home.manager.phaseCheckpoints!.commit("namespace:mission", 1, parsed, incomplete, "Answer"),
    ).rejects.toThrow("requirement");
    await home.manager.phaseCheckpoints!.commit(
      "namespace:mission",
      1,
      parsed,
      draft(parsed),
      "Parser inspection complete.",
    );
    const changed = continuation(parsed);
    changed.context.messages[1] = { role: "user", content: "A different task", timestamp: 1 };
    expect(home.manager.phaseCheckpoints!.apply("namespace:mission", changed).applied).toBe(false);
  } finally {
    home.close();
  }
});

test("a handoff budget rejects essential state instead of silently truncating it", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    const huge = draft(parsed).replace(
      "Inspect parser handling of quoted strings.",
      "Preserve this essential objective. ".repeat(10_000),
    );
    await expect(home.manager.phaseCheckpoints!.commit("namespace:mission", 1, parsed, huge, "Answer")).rejects.toThrow(
      "budget",
    );
    expect(home.manager.phaseCheckpoints!.apply("namespace:mission", continuation(parsed)).applied).toBe(false);
  } finally {
    home.close();
  }
});

test("a checkpoint requires the journal's confirmed browser answer and evidence reads stay session scoped", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    await expect(
      home.manager.phaseCheckpoints!.commit("namespace:mission", 1, parsed, draft(parsed), "Unconfirmed answer"),
    ).rejects.toThrow("confirmed");
    await home.manager.phaseCheckpoints!.commit(
      "namespace:mission",
      1,
      parsed,
      draft(parsed),
      "Parser inspection complete.",
    );
    const replay = home.manager.phaseCheckpoints!.apply("namespace:mission", continuation(parsed));
    const evidence = home.manager.phaseCheckpoints!.read(
      "namespace:mission",
      replay.checkpointRef!,
      "original_request",
      0,
      20,
    );
    expect(evidence.text).toBe("Fix the parser and v");
    expect(evidence.nextOffset).toBe(20);
    expect(() =>
      home.manager.phaseCheckpoints!.read("namespace:other", replay.checkpointRef!, "original_request", 0, 20),
    ).toThrow("ownership");
    expect(() =>
      home.manager.phaseCheckpoints!.read("namespace:mission", replay.checkpointRef!, "message:999", 0, 20),
    ).toThrow("reference");
  } finally {
    home.close();
  }
});

test("the real adapter commits a model checkpoint and recovers a lost temporary chat with a reduced handoff", async () => {
  const root = mkdtempSync("/tmp/cgw-phase-adapter-");
  roots.push(root);
  const journal = new SessionActorJournal(join(root, "private", "journal.sqlite"));
  const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "private", "results")));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: join(root, "broker.sock"),
      localToolsEnabled: true,
      solAvailable: true,
    },
  };
  let parsed = nativeRequest();
  const raw = parsed._rawBody as { input: unknown[] };
  raw.input.splice(1, 0, {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<environment_context>\n  <cwd>${root}</cwd>\n  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`,
      },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
  });
  parsed = parseRequest({ ...raw, model: parsed.modelId });
  let browserStarts = 0;
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const run = spyOn(worker, "run").mockImplementation(async (turn) => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      const token = /turn_token (turn_[A-Za-z0-9_-]+)/.exec(prepared.text)?.[1];
      if (!token) throw new Error("missing native capability");
      await turn.onSubmitted?.();
      if (browserStarts === 1) {
        expect(prepared.text).not.toContain("execute_tool");
        const manifest = await callTurnBroker<{ text: string }>(provider.chatgptWeb!.brokerSocketPath!, {
          method: "read_phase_checkpoint",
          token,
          arguments: { checkpoint_ref: "current", ref: "manifest" },
        });
        expect(JSON.parse(manifest.text).messages).toContainEqual({ index: 2, role: "user", ref: "message:2" });
        await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
          method: "submit_phase_checkpoint",
          token,
          summary: draft(parsed),
        });
        turn.onTextDelta?.("Parser inspection complete.");
        return "Parser inspection complete.";
      }
      expect(prepared.text).toContain("checkpoint_ref");
      expect(prepared.text).not.toContain("CODEX_ORIGINAL_USER_REQUEST_JSON");
      expect(prepared.text).toContain("Continue with the tests.");
      const checkpointRef = /checkpoint_ref ([a-f0-9]{64})/.exec(prepared.text)?.[1];
      expect(checkpointRef).toBeDefined();
      const evidence = await callTurnBroker<{ text: string }>(provider.chatgptWeb!.brokerSocketPath!, {
        method: "read_phase_checkpoint",
        token,
        arguments: { checkpoint_ref: checkpointRef, ref: "original_request" },
      });
      expect(evidence.text).toBe("Fix the parser and verify the regression. Preserve quoted strings.");
      turn.onTextDelta?.("Tests complete.");
      return "Tests complete.";
    } finally {
      prepared.release();
    }
  });
  try {
    const firstEvents: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider, { sessionActorManager: manager }).runTurn!(
      parsed,
      { headers: new Headers() },
      (event) => firstEvents.push(event),
    );
    expect(firstEvents.filter((event) => event.type === "error")).toEqual([]);
    const sessionId = `${chatGptWebExecutionNamespace(provider)}:${chatGptThreadOwnershipKey(parsed)}`;
    expect(journal.latestPhaseCheckpoint(sessionId, 1)).not.toBeNull();
    // A fresh adapter has no retained browser surface; its first payload must be the handoff.
    const secondEvents: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider, { sessionActorManager: manager }).runTurn!(
      continuation(parsed),
      { headers: new Headers() },
      (event) => secondEvents.push(event),
    );
    expect(secondEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(browserStarts).toBe(2);
  } finally {
    run.mockRestore();
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    journal.close();
  }
});

test.each([true, false])("local compaction retains a remote chat only with proven health=%s", async (healthy) => {
  const root = mkdtempSync("/tmp/cgw-compact-health-");
  roots.push(root);
  const journal = new SessionActorJournal(join(root, "private", "journal.sqlite"));
  const manager = new SessionActorManager(journal, new SessionResultStore(join(root, "private", "results")));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://${root}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: join(root, "broker.sock"),
      localToolsEnabled: true,
      solAvailable: true,
    },
  };
  const initial = nativeRequest("phase-1", root);
  const raw = initial._rawBody as { input: unknown[] };
  raw.input.splice(1, 0, {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<environment_context>\n<cwd>${root}</cwd>\n<filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`,
      },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
  });
  const parsed = parseRequest({ ...raw, model: initial.modelId });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const health = spyOn(worker, "conversationHealth").mockReturnValue(
    healthy
      ? {
          observedDomChars: 200_000,
          estimatedTokens: 5_000,
          compactionRequired: false,
          recoveryRequired: false,
        }
      : undefined,
  );
  let sourceKey: string | undefined;
  let continuationKey: string | undefined;
  let releases = 0;
  let starts = 0;
  const run = spyOn(worker, "run").mockImplementation(async (turn) => {
    starts += 1;
    if (starts === 3 && healthy) {
      expect(turn.prepareResume).toBeDefined();
    }
    const prepared = starts === 3 && healthy ? await turn.prepareResume!() : await turn.prepare();
    if (starts === 3 && healthy) {
      expect(prepared.text).toContain("Continue with the tests.");
      expect(prepared.text).not.toContain("CODEX_ORIGINAL_USER_REQUEST_JSON");
    }
    try {
      await turn.onSubmitted?.();
      if (turn.requireRetainedConversation) {
        const token = /turn_token (control_[a-f0-9]+)/.exec(prepared.text)?.[1];
        const handoffId = /handoff_id (handoff_[a-f0-9]+)/.exec(prepared.text)?.[1];
        if (!token || !handoffId) throw new Error("missing compaction capability");
        await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
          method: "submit_compaction_handoff",
          token,
          handoffId,
          summary: draft(parsed),
        });
        return draft(parsed);
      }
      if (starts === 1) sourceKey = turn.conversationKey;
      else continuationKey = turn.conversationKey;
      turn.onTextDelta("Parser inspection complete.");
      return "Parser inspection complete.";
    } finally {
      prepared.release();
    }
  });
  try {
    const adapter = createChatGptWebAdapter(provider, { sessionActorManager: manager });
    await adapter.runTurn!(parsed, { headers: new Headers() }, () => {});
    const session = chatGptTurnSessions.findConversationHead(sourceKey!);
    if (!session) throw new Error("missing retained source");
    session.runtime.releaseRetainedConversation = async () => {
      releases += 1;
    };
    const compact = { ...parsed, _compactionRequest: true };
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(compact, { headers: new Headers() }, (event) => events.push(event));
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    const summary = events
      .filter((event) => event.type === "text_delta")
      .map((event) => (event.type === "text_delta" ? event.text : ""))
      .join("");
    expect(summary).toContain("<compaction_state>");
    expect(releases).toBe(healthy ? 0 : 1);
    const next = continuation(parsed);
    next.context.messages.splice(2, 0, {
      role: "user",
      origin: "compaction_summary",
      content: `${SUMMARY_PREFIX}\n${summary}`,
      timestamp: 1,
    });
    const nextRaw = next._rawBody as { input: unknown[] };
    nextRaw.input.splice(3, 0, { type: "message", role: "user", content: `${SUMMARY_PREFIX}\n${summary}` });
    next.context.messages = [
      next.context.messages[0]!,
      next.context.messages.find((message) => message.role === "user" && message.origin === "compaction_summary")!,
      next.context.messages.at(-1)!,
    ];
    const nextEvents: AdapterEvent[] = [];
    await adapter.runTurn!(next, { headers: new Headers() }, (event) => nextEvents.push(event));
    expect(nextEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(continuationKey === sourceKey).toBe(healthy);
  } finally {
    run.mockRestore();
    health.mockRestore();
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    journal.close();
  }
});

test("checkpoint recovery preserves assistant commentary emitted before the confirmed final answer", async () => {
  const home = await fixture();
  try {
    const parsed = nativeRequest();
    await home.manager.phaseCheckpoints!.commit(
      "namespace:mission",
      1,
      parsed,
      draft(parsed),
      "Parser inspection complete.",
    );
    const next = continuation(parsed);
    const raw = next._rawBody as { input: unknown[] };
    raw.input.splice(2, 0, {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: "The quoted-string case still needs a regression test.",
      internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
    });
    const withCommentary = parseRequest({ ...raw, model: parsed.modelId });
    const replay = home.manager.phaseCheckpoints!.apply("namespace:mission", withCommentary);
    expect(replay.applied).toBe(true);
    expect(JSON.stringify(replay.parsed.context.messages)).toContain(
      "The quoted-string case still needs a regression test.",
    );
    expect(JSON.stringify(replay.parsed.context.messages)).toContain("Continue with the tests.");
    raw.input.splice(3, 0, {
      type: "message",
      role: "user",
      content: "A previously uncheckpointed requirement",
      internal_chat_message_metadata_passthrough: { turn_id: "phase-1" },
    });
    expect(
      home.manager.phaseCheckpoints!.apply("namespace:mission", parseRequest({ ...raw, model: parsed.modelId }))
        .applied,
    ).toBe(false);
  } finally {
    home.close();
  }
});
