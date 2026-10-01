import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import { chatGptWebExecutionNamespace, createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { listTurnCheckpoints } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import {
  SessionActorJournal,
  SessionActorManager,
  SessionResultStore,
} from "../src/adapters/chatgpt-web/session-actor";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { chatGptThreadOwnershipKey } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { decodeCompactionSummary } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const requestText = "Continue with the next step";

function fixture(root: string, sandboxMode: "workspace-write" | "read-only" = "workspace-write") {
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const config = defaultConfig("full");
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = join(root, "launcher.json");
  config.brokerSocketPath = defaultBrokerEndpoint(root);
  config.experimentalFreshConversationPerTurn = true;
  const metadata = {
    thread_id: `thread_${root.split("/").at(-1)}`,
    turn_id: "turn_compact_roundtrip",
    sandbox: sandboxMode,
    workspaces: { [workspace]: {} },
  };
  const source = {
    type: "message",
    role: "user",
    id: "msg_source_roundtrip",
    content: [{ type: "input_text", text: requestText }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_compact_roundtrip" },
  };
  const input = [
    {
      type: "message",
      role: "user",
      id: "msg_environment_roundtrip",
      content: [
        {
          type: "input_text",
          text: `<environment_context><cwd>${workspace}</cwd><sandbox_mode>${sandboxMode}</sandbox_mode></environment_context>`,
        },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_compact_roundtrip" },
    },
    source,
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Proceed with the implementation." }],
    },
    { type: "compaction_trigger" },
  ];
  const body = {
    model: "chatgpt-web/high",
    stream: false,
    input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  return { body, config, workspace, source };
}

function checkpoint() {
  return `<compaction_state>
version: 2
original_request_ref: sha256:${createHash("sha256").update(requestText).digest("hex")}
modified_files:
active_hypothesis: Continue the original task.
requirements:
- {"id":"REQ-1","status":"pending","source":"user turn turn_compact_roundtrip: ${requestText}"}
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

function post(body: unknown, config: ReturnType<typeof defaultConfig>, factory: Parameters<typeof responseRequest>[2]) {
  return responseRequest(
    new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    config,
    factory,
    { rememberState: false },
  );
}

for (const scenario of ["accepted", "repaired", "invalid", "persistence-failure"] as const) {
  test(`HTTP browser checkpoint ${scenario} preserves the native continuation contract`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-"));
    const { body, config, workspace, source } = fixture(root);
    const parsed = parseRequest(body);
    expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(workspace);
    if (scenario === "persistence-failure") {
      const outside = join(root, "outside");
      mkdirSync(outside);
      mkdirSync(join(workspace, ".agents"));
      symlinkSync(outside, join(workspace, ".agents", "checkpoints"));
    }
    let worker: ChatGptBrowserWorker | undefined;
    let originalRun: ChatGptBrowserWorker["run"] | undefined;
    let browserRuns = 0;
    let continuationRuns = 0;
    try {
      const response = await post(body, config, (provider) => {
        provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
        worker = ChatGptBrowserWorker.forProvider(provider);
        originalRun = worker.run.bind(worker);
        worker.run = async () => {
          browserRuns += 1;
          if (scenario === "invalid") return "The task is done.";
          if (scenario === "repaired" && browserRuns === 1) {
            return "<compaction_state>\nversion: 2\n<compaction_state>\nrequirements:\n- missing source\n</compaction_state>";
          }
          return checkpoint();
        };
        return createChatGptWebAdapter(provider);
      });
      const result = (await response.json()) as {
        status: string;
        output?: Array<{ type: string; encrypted_content?: string }>;
        error?: { code?: string };
      };
      const continuationFactory = (): ProviderAdapter => ({
        name: "roundtrip-continuation",
        async runTurn(parsedTurn, _incoming, emit) {
          continuationRuns += 1;
          expect(extractChatGptTurnUserRevision(parsedTurn)).toEqual(source.content);
          emit({ type: "text_delta", text: "Resumed original task", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      });
      if (scenario === "accepted" || scenario === "repaired") {
        expect(response.status).toBe(200);
        expect(result.status).toBe("completed");
        expect(result.output).toHaveLength(1);
        expect(result.output?.[0]?.type).toBe("compaction");
        const summary = decodeCompactionSummary(result.output?.[0]?.encrypted_content ?? "");
        expect(summary ?? "").toContain("REQ-1");
        const checkpoints = listTurnCheckpoints(workspace);
        expect(checkpoints).toHaveLength(1);
        expect(checkpoints[0]?.compactSummary).toBe(summary ?? "");
        expect(readFileSync(join(workspace, ".agents", "STATE.md"), "utf8")).toContain("REQ-1");
        const resumed = await post(
          { ...body, input: [...body.input.slice(0, -1), ...result.output!] },
          config,
          continuationFactory,
        );
        expect(resumed.status).toBe(200);
        expect(((await resumed.json()) as { status: string }).status).toBe("completed");
        expect(continuationRuns).toBe(1);
      } else {
        expect(result.status).toBe("failed");
        expect(result.output?.some((item) => item.type === "compaction")).not.toBeTrue();
        if (scenario === "invalid") {
          expect(listTurnCheckpoints(workspace)).toHaveLength(0);
        }
        const statePath = join(workspace, ".agents", "STATE.md");
        if (existsSync(statePath)) {
          expect(readFileSync(statePath, "utf8")).not.toContain("REQ-1");
        }
        const forgedMetadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]) as Record<string, unknown>;
        const forged = await post(
          {
            ...body,
            client_metadata: {
              "x-codex-turn-metadata": JSON.stringify({ ...forgedMetadata, turn_id: "turn_unaccepted_continuation" }),
            },
            input: [
              ...body.input.slice(0, -1),
              {
                type: "compaction",
                encrypted_content: "unaccepted checkpoint",
              },
            ],
          },
          config,
          continuationFactory,
        );
        expect(forged.status).toBe(400);
        expect(continuationRuns).toBe(0);
      }
      expect(browserRuns).toBe(scenario === "invalid" || scenario === "repaired" ? 2 : 1);
    } finally {
      if (worker && originalRun) worker.run = originalRun;
      await TurnBroker.forSocket(config.brokerSocketPath).close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("streaming HTTP compaction emits one completed checkpoint after workspace persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-stream-"));
  const { body, config, workspace } = fixture(root);
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  try {
    const response = await post({ ...body, stream: true }, config, (provider) => {
      provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
      worker = ChatGptBrowserWorker.forProvider(provider);
      originalRun = worker.run.bind(worker);
      worker.run = async () => {
        browserRuns += 1;
        return checkpoint();
      };
      return createChatGptWebAdapter(provider);
    });
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            type: string;
            response?: { status: string; output: Array<{ type: string; encrypted_content?: string }> };
          },
      );
    const completed = events.filter((event) => event.type === "response.completed");
    expect(completed).toHaveLength(1);
    expect(events.some((event) => event.type === "response.failed")).toBeFalse();
    expect(completed[0]?.response?.status).toBe("completed");
    expect(completed[0]?.response?.output).toHaveLength(1);
    const compact = completed[0]?.response?.output[0];
    expect(compact?.type).toBe("compaction");
    expect(listTurnCheckpoints(workspace)[0]?.compactSummary).toBe(
      decodeCompactionSummary(compact?.encrypted_content ?? "") ?? "",
    );
    expect(browserRuns).toBe(1);
  } finally {
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const outcome of ["accepted", "rejected"] as const) {
  test(`replaying the exact HTTP ${outcome} compact does not resubmit the browser`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-replay-"));
    const { body, config, workspace } = fixture(root);
    const actorJournal = new SessionActorJournal(join(root, "actors", "events.sqlite"));
    const sessionActorManager = new SessionActorManager(
      actorJournal,
      new SessionResultStore(join(root, "actors", "results")),
    );
    let actorSessionId: string | undefined;
    let worker: ChatGptBrowserWorker | undefined;
    let originalRun: ChatGptBrowserWorker["run"] | undefined;
    let browserRuns = 0;
    const factory: Parameters<typeof responseRequest>[2] = (provider) => {
      provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
      actorSessionId = `${chatGptWebExecutionNamespace(provider)}:${chatGptThreadOwnershipKey(parseRequest(body))}`;
      worker = ChatGptBrowserWorker.forProvider(provider);
      if (!originalRun) originalRun = worker.run.bind(worker);
      worker.run = async () => {
        browserRuns += 1;
        return outcome === "accepted" ? checkpoint() : "There is no checkpoint.";
      };
      return createChatGptWebAdapter(provider, { sessionActorManager });
    };
    try {
      const first = await post(body, config, factory);
      const firstResult = (await first.json()) as {
        status: string;
        output?: Array<{ type: string; encrypted_content?: string }>;
      };
      const firstRuns = browserRuns;
      const second = await post(body, config, factory);
      const secondResult = (await second.json()) as typeof firstResult;
      expect(firstResult.status).toBe(outcome === "accepted" ? "completed" : "failed");
      expect(secondResult.status).toBe(firstResult.status);
      expect(browserRuns).toBe(firstRuns);
      expect(actorJournal.snapshot(actorSessionId!)?.historyRevision).toBe(outcome === "accepted" ? 1 : 0);
      expect(actorJournal.snapshot(actorSessionId!)?.compactionEpoch).toBe(outcome === "accepted" ? 1 : 0);
      if (outcome === "accepted") {
        expect(firstResult.output?.[0]?.type).toBe("compaction");
        expect(secondResult.output?.[0]?.type).toBe("compaction");
        expect(decodeCompactionSummary(secondResult.output?.[0]?.encrypted_content ?? "")).toBe(
          decodeCompactionSummary(firstResult.output?.[0]?.encrypted_content ?? ""),
        );
        expect(listTurnCheckpoints(workspace)).toHaveLength(1);
      } else {
        expect(firstRuns).toBe(2);
        expect(secondResult.output?.some((item) => item.type === "compaction")).not.toBeTrue();
        expect(listTurnCheckpoints(workspace)).toHaveLength(0);
      }
    } finally {
      if (worker && originalRun) worker.run = originalRun;
      await TurnBroker.forSocket(config.brokerSocketPath).close();
      actorJournal.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("HTTP compaction keeps identical native turn ids isolated by thread", async () => {
  const rootA = mkdtempSync(join(tmpdir(), "cgw-roundtrip-thread-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "cgw-roundtrip-thread-b-"));
  const sessions = [fixture(rootA), fixture(rootB)];
  const sharedConfig = sessions[0]!.config;
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  try {
    for (const { body, workspace } of sessions) {
      const response = await post(body, sharedConfig, (provider) => {
        provider.chatgptWeb!.threadEnvironmentStatePath = join(rootA, "thread-environments.json");
        worker = ChatGptBrowserWorker.forProvider(provider);
        if (!originalRun) originalRun = worker.run.bind(worker);
        worker.run = async () => {
          browserRuns += 1;
          return checkpoint().replace("Continue the original task.", `Continue in ${workspace}.`);
        };
        return createChatGptWebAdapter(provider);
      });
      const result = (await response.json()) as {
        status: string;
        output: Array<{ type: string; encrypted_content?: string }>;
      };
      expect(result.status).toBe("completed");
      expect(result.output[0]?.type).toBe("compaction");
      const checkpoints = listTurnCheckpoints(workspace);
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.compactSummary).toContain(`Continue in ${workspace}.`);
    }
    expect(browserRuns).toBe(2);
    expect(sessions[0]!.workspace).not.toBe(sessions[1]!.workspace);
  } finally {
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(sharedConfig.brokerSocketPath).close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("concurrent identical HTTP compact requests share one browser result and checkpoint epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-concurrent-"));
  const { body, config, workspace } = fixture(root);
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  let factoryCalls = 0;
  let notifyStarted!: () => void;
  let notifySecond!: () => void;
  let releaseBrowser!: (value: string) => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const secondAdmitted = new Promise<void>((resolve) => {
    notifySecond = resolve;
  });
  const browserResult = new Promise<string>((resolve) => {
    releaseBrowser = resolve;
  });
  const factory: Parameters<typeof responseRequest>[2] = (provider) => {
    factoryCalls += 1;
    if (factoryCalls === 2) notifySecond();
    provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
    worker = ChatGptBrowserWorker.forProvider(provider);
    if (!originalRun) originalRun = worker.run.bind(worker);
    worker.run = async () => {
      browserRuns += 1;
      notifyStarted();
      return browserResult;
    };
    return createChatGptWebAdapter(provider);
  };
  try {
    const first = post(body, config, factory);
    await started;
    const second = post(body, config, factory);
    await secondAdmitted;
    releaseBrowser(checkpoint());
    const responses = await Promise.all([first, second]);
    const results = await Promise.all(
      responses.map(
        async (response) =>
          response.json() as Promise<{
            status: string;
            output: Array<{ type: string; encrypted_content?: string }>;
          }>,
      ),
    );
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    const summaries = results.map((result) => decodeCompactionSummary(result.output[0]?.encrypted_content ?? ""));
    expect(summaries[0] ?? "").toContain("REQ-1");
    expect(summaries[1]).toBe(summaries[0]);
    expect(browserRuns).toBe(1);
    expect(listTurnCheckpoints(workspace)).toHaveLength(1);
  } finally {
    releaseBrowser(checkpoint());
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stream disconnect followed by an exact HTTP reconnect keeps one browser handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-disconnect-"));
  const { body, config, workspace } = fixture(root);
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  let notifyStarted!: () => void;
  let releaseBrowser!: (value: string) => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const browserResult = new Promise<string>((resolve) => {
    releaseBrowser = resolve;
  });
  const factory: Parameters<typeof responseRequest>[2] = (provider) => {
    provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
    worker = ChatGptBrowserWorker.forProvider(provider);
    if (!originalRun) originalRun = worker.run.bind(worker);
    worker.run = async () => {
      browserRuns += 1;
      notifyStarted();
      return browserResult;
    };
    return createChatGptWebAdapter(provider);
  };
  try {
    const disconnected = await post({ ...body, stream: true }, config, factory);
    await started;
    await disconnected.body!.cancel();
    const reconnect = post(body, config, factory);
    releaseBrowser(checkpoint());
    const result = (await (await reconnect).json()) as {
      status: string;
      output: Array<{ type: string; encrypted_content?: string }>;
    };
    expect(result.status).toBe("completed");
    expect(result.output[0]?.type).toBe("compaction");
    expect(decodeCompactionSummary(result.output[0]?.encrypted_content ?? "") ?? "").toContain("REQ-1");
    expect(browserRuns).toBe(1);
    expect(listTurnCheckpoints(workspace)).toHaveLength(1);
  } finally {
    releaseBrowser(checkpoint());
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changed HTTP compact revision cannot replace an active handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-revision-"));
  const { body, config, workspace, source } = fixture(root);
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  let notifyStarted!: () => void;
  let releaseBrowser!: (value: string) => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const browserResult = new Promise<string>((resolve) => {
    releaseBrowser = resolve;
  });
  const factory: Parameters<typeof responseRequest>[2] = (provider) => {
    provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
    worker = ChatGptBrowserWorker.forProvider(provider);
    if (!originalRun) originalRun = worker.run.bind(worker);
    worker.run = async () => {
      browserRuns += 1;
      notifyStarted();
      return browserResult;
    };
    return createChatGptWebAdapter(provider);
  };
  let first: Promise<Response> | undefined;
  let revisedRequest: Promise<{ status: string; error?: { code?: string } }> | undefined;
  try {
    first = post(body, config, factory);
    await started;
    const changed = {
      ...body,
      input: [
        body.input[0],
        { ...source, content: [{ type: "input_text", text: "Replace the original task" }] },
        ...body.input.slice(2),
      ],
    };
    revisedRequest = post(changed, config, factory).then(
      (response) =>
        response.json() as Promise<{
          status: string;
          error?: { code?: string };
        }>,
    );
    const revised = await Promise.race([revisedRequest, Bun.sleep(200).then(() => null)]);
    expect(revised).not.toBeNull();
    expect(revised?.status).toBe("failed");
    expect(revised?.error?.code).toBe("compaction_revision_conflict");
    expect(browserRuns).toBe(1);
    releaseBrowser(checkpoint());
    const original = (await (await first).json()) as { status: string };
    expect(original.status).toBe("completed");
    expect(listTurnCheckpoints(workspace)).toHaveLength(1);
  } finally {
    releaseBrowser(checkpoint());
    if (first) await first.catch(() => undefined);
    if (revisedRequest) await revisedRequest.catch(() => undefined);
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only HTTP compaction returns a checkpoint without writing workspace state", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-readonly-"));
  const { body, config, workspace } = fixture(root, "read-only");
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  try {
    const response = await post(body, config, (provider) => {
      provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
      worker = ChatGptBrowserWorker.forProvider(provider);
      originalRun = worker.run.bind(worker);
      worker.run = async () => {
        browserRuns += 1;
        return checkpoint();
      };
      return createChatGptWebAdapter(provider);
    });
    const result = (await response.json()) as {
      status: string;
      output: Array<{ type: string; encrypted_content?: string }>;
    };
    expect(result.status).toBe("completed");
    expect(result.output[0]?.type).toBe("compaction");
    expect(browserRuns).toBe(1);
    expect(existsSync(join(workspace, ".agents"))).toBeFalse();
  } finally {
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("contradictory sandbox metadata cannot authorize HTTP checkpoint persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-sandbox-"));
  const { body, config, workspace } = fixture(root);
  const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]) as Record<string, unknown>;
  const conflicting = {
    ...body,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ ...metadata, sandbox: "read-only" }),
    },
  };
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  try {
    const response = await post(conflicting, config, (provider) => {
      provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
      worker = ChatGptBrowserWorker.forProvider(provider);
      originalRun = worker.run.bind(worker);
      worker.run = async () => {
        browserRuns += 1;
        return checkpoint();
      };
      return createChatGptWebAdapter(provider);
    });
    const result = (await response.json()) as { status?: string; output?: Array<{ type: string }> };
    expect(result.status).not.toBe("completed");
    expect(result.output?.some((item) => item.type === "compaction")).not.toBeTrue();
    expect(browserRuns).toBe(0);
    expect(existsSync(join(workspace, ".agents"))).toBeFalse();
  } finally {
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stream of [false, true]) {
  test(`tagged but invalid draft and repair fail safely over HTTP (stream=${stream})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-invalid-repair-"));
    const { body, config, workspace } = fixture(root);
    config.experimentalFreshConversationPerTurn = false;
    const invalidDraft = `<compaction_state>
modified_files:
active_hypothesis: Continue the original task.
requirements:
- {"id":"REQ bad","status":"pending","source":"${requestText}"}
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
pending_obligations:
next_actions:
- Continue with the next step
</compaction_state>`;
    const invalidRepair = `<compaction_state>
modified_files:
active_hypothesis: Continue the original task.
requirements:
- {"id":"REQ bad","status":"pending","source":"${requestText}"}
closure_criteria:
- Finish the task
verified_achievements:
decisions_and_invariants:
blockers_or_test_failures:
pending_obligations:
next_actions:
- Continue with the next step
</compaction_state>`;
    let worker: ChatGptBrowserWorker | undefined;
    let originalRun: ChatGptBrowserWorker["run"] | undefined;
    let browserRuns = 0;
    let repairPrompt = "";
    const factory: Parameters<typeof responseRequest>[2] = (provider) => {
      provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
      worker = ChatGptBrowserWorker.forProvider(provider);
      if (!originalRun) originalRun = worker.run.bind(worker);
      worker.run = async (turn) => {
        browserRuns += 1;
        if (browserRuns === 1) return invalidDraft;
        const prepared = await turn.prepare();
        repairPrompt = prepared.text;
        prepared.release();
        return invalidRepair;
      };
      return createChatGptWebAdapter(provider);
    };
    try {
      const first = await post({ ...body, stream }, config, factory);
      const payload = stream ? await first.text() : JSON.stringify(await first.json());
      expect(payload).toContain("context_checkpoint_validation_failed");
      expect(payload).not.toContain('"type":"compaction"');
      expect(repairPrompt).toContain("Checkpoint requires mission checklist version 2");
      expect(repairPrompt).toContain("Missing original request reference");
      expect(repairPrompt).toContain("Mission requirement has an invalid stable ID");
      expect(repairPrompt).toContain(requestText);
      expect(browserRuns).toBe(2);
      expect(listTurnCheckpoints(workspace)).toHaveLength(0);
      const statePath = join(workspace, ".agents", "STATE.md");
      if (existsSync(statePath)) {
        expect(readFileSync(statePath, "utf8")).not.toContain("REQ bad");
      }

      const replay = await post({ ...body, stream }, config, factory);
      const replayPayload = stream ? await replay.text() : JSON.stringify(await replay.json());
      expect(replayPayload).toContain("context_checkpoint_validation_failed");
      expect(replayPayload).not.toContain('"type":"compaction"');
      expect(browserRuns).toBe(2);
      expect(listTurnCheckpoints(workspace)).toHaveLength(0);
    } finally {
      if (worker && originalRun) worker.run = originalRun;
      await TurnBroker.forSocket(config.brokerSocketPath).close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("HTTP handoff timeout and exact replay never persist a late browser result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-roundtrip-timeout-"));
  const { body, config, workspace } = fixture(root);
  let worker: ChatGptBrowserWorker | undefined;
  let originalRun: ChatGptBrowserWorker["run"] | undefined;
  let browserRuns = 0;
  let releaseBrowser!: (value: string) => void;
  const browserResult = new Promise<string>((resolve) => {
    releaseBrowser = resolve;
  });
  const factory: Parameters<typeof responseRequest>[2] = (provider) => {
    provider.chatgptWeb!.threadEnvironmentStatePath = join(root, "thread-environments.json");
    provider.chatgptWeb!.turnTimeoutMs = 25;
    worker = ChatGptBrowserWorker.forProvider(provider);
    if (!originalRun) originalRun = worker.run.bind(worker);
    worker.run = async () => {
      browserRuns += 1;
      return browserResult;
    };
    return createChatGptWebAdapter(provider);
  };
  try {
    const first = await post(body, config, factory);
    const firstResult = (await first.json()) as {
      status: string;
      output?: Array<{ type: string }>;
      error?: { code?: string };
    };
    expect(firstResult.status).toBe("failed");
    expect(firstResult.error?.code).toBe("compaction_handoff_timeout");
    expect(firstResult.output?.some((item) => item.type === "compaction")).not.toBeTrue();

    const replay = await post(body, config, factory);
    const replayResult = (await replay.json()) as typeof firstResult;
    expect(replayResult.status).toBe("failed");
    expect(replayResult.error?.code).toBe("compaction_handoff_timeout");
    expect(browserRuns).toBe(1);

    releaseBrowser(checkpoint());
    await Bun.sleep(10);
    expect(listTurnCheckpoints(workspace)).toHaveLength(0);
  } finally {
    releaseBrowser(checkpoint());
    if (worker && originalRun) worker.run = originalRun;
    await TurnBroker.forSocket(config.brokerSocketPath).close();
    rmSync(root, { recursive: true, force: true });
  }
});
