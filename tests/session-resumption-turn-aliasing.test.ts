import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserTurn, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

test("turn broker resolves retired token to active successor via threadId when traceIds differ", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-thread-alias-1-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const threadId = "thread_resume_test_alpha_1";

    // Turn 1 has its own traceId and token
    const token1 = await broker.register(
      environment,
      60_000,
      "trace-turn-1-unique",
      false,
      "turn",
      undefined,
      threadId,
    );

    // Commit Turn 1 and revoke it
    const rev1 = broker.beginCompletionFence(token1);
    expect(rev1).toBeDefined();
    expect(broker.commitCompletionFence(token1, rev1!)).toBeTrue();
    broker.revoke(token1);

    // Turn 2 starts for the SAME thread, but has a different traceId and NO explicit predecessor passed
    const token2 = await broker.register(
      environment,
      60_000,
      "trace-turn-2-unique",
      false,
      "turn",
      undefined,
      threadId,
    );
    expect(token2).not.toBe(token1);

    // An agent in ChatGPT Web still has token1 in its context and issues an MCP tool call.
    // It should automatically resolve to active token2 on the same thread without throwing "Session terminated"!
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_thread_resumption_1234",
    });

    expect(claimed.bindingId).toBeDefined();
    expect(claimed.activityId).toBe("activity_thread_resumption_1234");

    // Settle the activity
    const settled = await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token1,
      activityId: "activity_thread_resumption_1234",
    });
    expect(settled.completed).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-turn chain resolves T1 and T2 to active T3 across distinct traceIds for the same thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-thread-chain-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const threadId = "thread_resume_multi_chain";

    const token1 = await broker.register(environment, 60_000, "trace-t1", false, "turn", undefined, threadId);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    broker.revoke(token1);

    const token2 = await broker.register(environment, 60_000, "trace-t2", false, "turn", undefined, threadId);
    const rev2 = broker.beginCompletionFence(token2);
    broker.commitCompletionFence(token2, rev2!);
    broker.revoke(token2);

    const token3 = await broker.register(environment, 60_000, "trace-t3", false, "turn", undefined, threadId);

    // Claim with T1 resolves to active T3
    const claimed1 = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_from_t1_to_t3_12345",
    });
    expect(claimed1.bindingId).toBeDefined();

    // Claim with T2 also resolves to active T3
    const claimed2 = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token2,
      activityId: "activity_from_t2_to_t3_12345",
    });
    expect(claimed2.bindingId).toBe(claimed1.bindingId);

    const settled = await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token3,
      activityId: "activity_from_t1_to_t3_12345",
    });
    expect(settled.completed).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict thread isolation prevents cross-thread token resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-thread-isolation-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 120_000, 200);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    // Thread A has token 1
    const tokenA = await broker.register(
      environment,
      60_000,
      "trace-thread-a",
      false,
      "turn",
      undefined,
      "thread_workspace_alpha",
    );
    const revA = broker.beginCompletionFence(tokenA);
    broker.commitCompletionFence(tokenA, revA!);
    broker.revoke(tokenA);

    // Thread B is active with token B
    const _tokenB = await broker.register(
      environment,
      60_000,
      "trace-thread-b",
      false,
      "turn",
      undefined,
      "thread_workspace_beta",
    );

    // Claiming with tokenA MUST fail closed because thread_workspace_alpha has NO active successor
    // It must NEVER alias to thread_workspace_beta!
    await expect(
      callTurnBroker(socketPath, {
        method: "claim",
        token: tokenA,
        activityId: "activity_cross_leak_attempt_123",
      }),
    ).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("host-only turns strictly refuse thread-level aliasing and lineage resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-host-thread-iso-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const hostEnv = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      execution: "host-only" as const,
      tools: [],
    };

    const hostToken1 = await broker.register(
      hostEnv,
      60_000,
      "trace-host-1",
      false,
      "turn",
      undefined,
      "thread_host_123",
    );
    expect(hostToken1.startsWith("host_")).toBeTrue();

    const rev = broker.beginCompletionFence(hostToken1);
    broker.commitCompletionFence(hostToken1, rev!);
    broker.revoke(hostToken1);

    const _hostToken2 = await broker.register(
      hostEnv,
      60_000,
      "trace-host-2",
      false,
      "turn",
      undefined,
      "thread_host_123",
    );

    // Host capabilities must never alias through thread lineage
    await expect(
      callTurnBroker(socketPath, {
        method: "claim",
        token: hostToken1,
        activityId: "activity_host_leak_12345678",
      }),
    ).rejects.toThrow("already finished");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("inter-turn claim grace wait seamlessly resolves if successor registers within grace window", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-thread-grace-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };

    const threadId = "thread_grace_handoff_test";

    const token1 = await broker.register(environment, 60_000, "trace-grace-1", false, "turn", undefined, threadId);
    const rev1 = broker.beginCompletionFence(token1);
    broker.commitCompletionFence(token1, rev1!);
    broker.revoke(token1);

    // Start claim in background BEFORE Turn 2 registers
    const claimPromise = callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_grace_wait_12345678",
    });

    // Successor registers 80ms later
    await Bun.sleep(80);
    const token2 = await broker.register(environment, 60_000, "trace-grace-2", false, "turn", undefined, threadId);

    const claimed = await claimPromise;
    expect(claimed.bindingId).toBeDefined();

    // Verify activity settled on token2 channel
    const settled = await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token2,
      activityId: "activity_grace_wait_12345678",
    });
    expect(settled.completed).toBeTrue();
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end adapter: consecutive runTurn calls for the same thread alias Turn 1 token to active Turn 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-adapter-resumption-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://adapter-resumption-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const adapter = createChatGptWebAdapter(provider, { broker });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);

  let token1 = "";
  let token2 = "";
  let toolClaimSucceededInTurn2 = false;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async (turn) => {
    const prepared = await turn.prepare();
    const tokenMatch = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/);
    if (!tokenMatch) throw new Error("Missing turn token in prepared prompt");
    const extractedToken = tokenMatch[1];

    if (!token1) {
      token1 = extractedToken;
      turn.onSubmitted?.();
      const answer = "Turn 1 complete";
      turn.onTextDelta(answer);
      return answer;
    }

    token2 = extractedToken;
    expect(token2).not.toBe(token1);
    turn.onSubmitted?.();

    // While Turn 2 is running and active, execute tool claim using Turn 1's token!
    const claimed = await callTurnBroker<{ bindingId: string; activityId: string }>(socketPath, {
      method: "claim",
      token: token1,
      activityId: "activity_e2e_resumption_turn1_token",
    });
    expect(claimed.bindingId).toBeDefined();

    const settled = await callTurnBroker<{ completed: boolean }>(socketPath, {
      method: "activity_complete",
      token: token1,
      activityId: "activity_e2e_resumption_turn1_token",
    });
    expect(settled.completed).toBeTrue();
    toolClaimSucceededInTurn2 = true;

    const answer = "Turn 2 complete with tool";
    turn.onTextDelta(answer);
    return answer;
  };

  try {
    const envXml = `<environment_context>
      <cwd>${root}</cwd>
      <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
    </environment_context>`;

    const threadId = "thread_adapter_e2e_resumption_alpha";

    const req1: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [{ role: "user", content: "Turn 1 request", timestamp: 1 }],
      },
      options: { reasoning: "high" },
      _rawBody: {
        prompt_cache_key: threadId,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "turn_adapter_1" }),
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: envXml }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_adapter_1" },
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Turn 1 request" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_adapter_1" },
          },
        ],
      },
    };

    const events1: AdapterEvent[] = [];
    await adapter.runTurn!(req1, { headers: new Headers() }, (event) => events1.push(event));
    expect(token1).toBeTruthy();
    expect(events1.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });

    const req2: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [
          { role: "user", content: "Turn 1 request", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Turn 1 complete" }], timestamp: 2 },
          { role: "user", content: "Turn 2 request", timestamp: 3 },
        ],
      },
      options: { reasoning: "high" },
      _rawBody: {
        prompt_cache_key: threadId,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: "turn_adapter_2" }),
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: envXml }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_adapter_2" },
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Turn 2 request" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_adapter_2" },
          },
        ],
      },
    };

    const events2: AdapterEvent[] = [];
    await adapter.runTurn!(req2, { headers: new Headers() }, (event) => events2.push(event));
    expect(token2).toBeTruthy();
    expect(toolClaimSucceededInTurn2).toBeTrue();
    expect(events2.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });

    // After Turn 2 completes, neither token is active, so claiming must fail closed!
    await expect(
      callTurnBroker(socketPath, {
        method: "claim",
        token: token1,
        activityId: "activity_after_turns_complete",
      }),
    ).rejects.toThrow("already finished");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end adapter: separate threads remain strictly isolated and never share or alias tokens", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-adapter-thread-iso-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 120_000, 200);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://adapter-isolation-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const adapter = createChatGptWebAdapter(provider, { broker });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);

  let tokenThreadA = "";
  let tokenThreadB = "";
  let crossThreadClaimFailedClosed = false;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async (turn) => {
    const prepared = await turn.prepare();
    const tokenMatch = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/);
    const extractedToken = tokenMatch![1];

    if (!tokenThreadA) {
      tokenThreadA = extractedToken;
      turn.onSubmitted?.();
      const answer = "Thread A turn finished";
      turn.onTextDelta(answer);
      return answer;
    }

    tokenThreadB = extractedToken;
    turn.onSubmitted?.();

    // While Thread B's turn is active, attempt to claim using Thread A's token!
    try {
      await callTurnBroker(socketPath, {
        method: "claim",
        token: tokenThreadA,
        activityId: "activity_cross_thread_illegal_claim",
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already finished")) {
        crossThreadClaimFailedClosed = true;
      }
    }

    const answer = "Thread B turn finished";
    turn.onTextDelta(answer);
    return answer;
  };

  try {
    const envXml = `<environment_context>
      <cwd>${root}</cwd>
      <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
    </environment_context>`;

    // Turn 1 on Thread A
    const reqA: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [{ role: "user", content: "Thread A request", timestamp: 1 }],
      },
      options: { reasoning: "high" },
      _rawBody: {
        prompt_cache_key: "thread_A",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_A", turn_id: "turn_A_1" }),
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: envXml }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_A_1" },
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Thread A request" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_A_1" },
          },
        ],
      },
    };

    await adapter.runTurn!(reqA, { headers: new Headers() }, () => {});
    expect(tokenThreadA).toBeTruthy();

    // Turn 2 on Thread B
    const reqB: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [{ role: "user", content: "Thread B request", timestamp: 1 }],
      },
      options: { reasoning: "high" },
      _rawBody: {
        prompt_cache_key: "thread_B",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_B", turn_id: "turn_B_1" }),
        },
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: envXml }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_B_1" },
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Thread B request" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_B_1" },
          },
        ],
      },
    };

    await adapter.runTurn!(reqB, { headers: new Headers() }, () => {});
    expect(tokenThreadB).toBeTruthy();
    expect(crossThreadClaimFailedClosed).toBeTrue();
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end adapter: host-only turns strictly refuse predecessor aliasing even within the same thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-adapter-host-iso-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath, 120_000, 200);
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://adapter-host-iso-${Date.now()}`,
    chatgptWeb: {
      brokerSocketPath: socketPath,
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
  };
  const adapter = createChatGptWebAdapter(provider, { broker });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);

  let hostToken1 = "";
  let hostToken2 = "";
  let hostClaimFailedClosed = false;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async (turn) => {
    const prepared = await turn.prepare();
    const tokenMatch = prepared.text.match(/turn_token (host_[A-Za-z0-9_-]+)/);
    const extractedToken = tokenMatch![1];

    if (!hostToken1) {
      hostToken1 = extractedToken;
      expect(hostToken1.startsWith("host_")).toBeTrue();
      turn.onSubmitted?.();
      const answer = "Host turn 1 finished";
      turn.onTextDelta(answer);
      return answer;
    }

    hostToken2 = extractedToken;
    expect(hostToken2.startsWith("host_")).toBeTrue();
    expect(hostToken2).not.toBe(hostToken1);
    turn.onSubmitted?.();

    // While Host Turn 2 is active, attempting to claim using Host Turn 1's token MUST fail closed!
    try {
      await callTurnBroker(socketPath, {
        method: "claim",
        token: hostToken1,
        activityId: "activity_host_alias_illegal_claim",
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already finished")) {
        hostClaimFailedClosed = true;
      }
    }

    const answer = "Host turn 2 finished";
    turn.onTextDelta(answer);
    return answer;
  };

  try {
    const sessionId = "thread_host_shared_session";

    const hostReq1: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [{ role: "user", content: "Host request 1", timestamp: 1 }],
      },
      options: { reasoning: "high" },
      _hostTurn: {
        sessionId,
        turnId: "turn_host_1",
        environment: {
          execution: "host-only",
          cwd: root,
          roots: [],
          writableRoots: [],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        },
      },
      _rawBody: {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Host request 1" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_host_1" },
          },
        ],
      },
    };

    await adapter.runTurn!(hostReq1, { headers: new Headers() }, () => {});
    expect(hostToken1).toBeTruthy();

    const hostReq2: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      context: {
        tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        messages: [
          { role: "user", content: "Host request 1", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Host turn 1 finished" }], timestamp: 2 },
          { role: "user", content: "Host request 2", timestamp: 3 },
        ],
      },
      options: { reasoning: "high" },
      _hostTurn: {
        sessionId,
        turnId: "turn_host_2",
        environment: {
          execution: "host-only",
          cwd: root,
          roots: [],
          writableRoots: [],
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
        },
      },
      _rawBody: {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Host request 2" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_host_2" },
          },
        ],
      },
    };

    await adapter.runTurn!(hostReq2, { headers: new Headers() }, () => {});
    expect(hostToken2).toBeTruthy();
    expect(hostClaimFailedClosed).toBeTrue();
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
