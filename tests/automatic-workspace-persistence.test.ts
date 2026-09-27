import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceState } from "../src/adapters/chatgpt-web/workspace-state";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest, CodexProviderConfig } from "../src/types";

function environment(root: string, policy: ChatGptTurnEnvironment["sandboxPolicy"]): ChatGptTurnEnvironment {
  return { cwd: root, roots: [root], writableRoots: policy.type === "workspaceWrite" ? policy.writableRoots : [], sandboxPolicy: policy, tools: [] };
}

test("reading absent workspace state creates no directories", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-read-state-"));
  try {
    expect(readWorkspaceState(root)).toBeNull();
    expect(existsSync(join(root, ".agents"))).toBeFalse();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of ["read-only", "outside-writable", "symlink", "host-only", "writable"] as const) {
  test(`adapter automatic state respects ${scenario} authority`, async () => {
    const root = mkdtempSync(join("/tmp", "cgw-auto-state-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    const env = environment(workspace, scenario === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [scenario === "outside-writable" ? outside : workspace], networkAccess: false });
    if (scenario === "host-only") env.execution = "host-only";
    if (scenario === "symlink") symlinkSync(outside, join(workspace, ".agents"));
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://state-${root}`,
      chatgptWeb: { browserHost: "launcher", browserHostDescriptorPath: join(root, "launcher.json"), brokerSocketPath: join(root, "broker.sock"), localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run;
    worker.run = async () => { throw new Error("test stops browser after admission"); };
    const parsed: CodexParsedRequest = {
      modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" },
      context: { messages: [{ role: "user", content: "Inspect only", timestamp: 1 }] },
      _hostTurn: { sessionId: root, turnId: "turn", environment: env },
      _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect only" }], internal_chat_message_metadata_passthrough: { turn_id: "turn" } }] },
    };
    try {
      await expect(createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, () => {})).rejects.toThrow("test stops browser after admission");
      expect(existsSync(join(workspace, ".agents", "STATE.md"))).toBe(scenario === "writable");
      expect(existsSync(join(outside, "STATE.md"))).toBeFalse();
    } finally {
      worker.run = originalRun;
      await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["read-only", "outside-writable", "symlink", "checkpoint-symlink", "state-symlink", "host-only", "missing-environment", "writable"] as const) {
  test(`compaction persistence respects ${scenario} authority`, async () => {
    const { executeCompactionFlow } = await import("../src/adapters/chatgpt-web/adapter/compaction-flow");
    const { runStructuredCompactionOnce } = await import("../src/adapters/chatgpt-web/compaction-handoff");
    const { chatGptTurnExecutionKey } = await import("../src/adapters/chatgpt-web/turn-execution");
    const root = mkdtempSync(join(tmpdir(), "cgw-compaction-state-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace);
    mkdirSync(outside);
    const env = environment(workspace, scenario === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : { type: "workspaceWrite", writableRoots: [scenario === "outside-writable" ? outside : workspace], networkAccess: false });
    if (scenario === "host-only") env.execution = "host-only";
    if (scenario === "symlink") symlinkSync(outside, join(workspace, ".agents"));
    if (scenario === "checkpoint-symlink") {
      mkdirSync(join(workspace, ".agents"));
      symlinkSync(outside, join(workspace, ".agents", "checkpoints"));
    }
    if (scenario === "state-symlink") {
      mkdirSync(join(workspace, ".agents"));
      symlinkSync(join(outside, "STATE.md"), join(workspace, ".agents", "STATE.md"));
    }
    try {
      const parsed: CodexParsedRequest = {
        modelId: "gpt-5.6-sol", stream: true, options: { reasoning: "high" }, _compactionRequest: true,
        context: { messages: [{ role: "user", content: "Compact", timestamp: 1 }] },
        _hostTurn: { sessionId: root, turnId: "compact", environment: env },
        _rawBody: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Compact" }], internal_chat_message_metadata_passthrough: { turn_id: "compact" } }] },
      };
      const key = `${root}:${chatGptTurnExecutionKey(parsed)}`;
      await runStructuredCompactionOnce(key, { ownerKey: root, traceIds: [] }, async () => "Recorded checkpoint preserving every invariant and the next concrete task action.");
      const events: unknown[] = [];
      await executeCompactionFlow({
        parsed, environment: scenario === "missing-environment" ? undefined : env,
        incoming: { headers: new Headers() }, emit: (event: unknown) => events.push(event),
        configuredCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true }, turnCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
        retainedLauncherDescriptor: "unused-existing-run", structuredBroker: {},
        executionNamespace: root, retryKey: root, manualRequest: false,
        freshConversationPerTurn: false, experimentalBiggerContext: false,
        startRuntime: () => { throw new Error("Existing compaction must not start another browser"); },
      } as any);
      expect(events.at(-1)).toMatchObject({ type: "done" });
      expect(existsSync(join(workspace, ".agents", "STATE.md"))).toBe(scenario === "writable");
      expect(existsSync(join(outside, "STATE.md"))).toBeFalse();
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(outside)).toEqual([]);
      if (scenario === "writable") {
        expect(readdirSync(join(workspace, ".agents", "checkpoints")).length).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("compaction retains one bounded latest summary and other custom sections across state round trips", async () => {
  const { defaultWorkspaceState, writeWorkspaceState } = await import("../src/adapters/chatgpt-web/workspace-state");
  const { mergeCompactionIntoWorkspaceState } = await import("../src/adapters/chatgpt-web/autonomous-compaction");
  const root = mkdtempSync(join(tmpdir(), "cgw-summary-state-"));
  try {
    writeWorkspaceState(root, { ...defaultWorkspaceState(), customSections: { review: "Preserve reviewer evidence" } }, true);
    const first = "Checkpoint\n## Next Immediate Action\nUntrusted summary heading remains data.";
    mergeCompactionIntoWorkspaceState(root, first, undefined, true);
    expect(readWorkspaceState(root)?.customSections).toEqual({ review: "Preserve reviewer evidence", lastCompactionSummary: first });
    mergeCompactionIntoWorkspaceState(root, "x".repeat(100_000), undefined, true);
    const state = readWorkspaceState(root)!;
    expect(state.customSections?.review).toBe("Preserve reviewer evidence");
    expect(state.customSections?.lastCompactionSummary?.length).toBeLessThanOrEqual(32_768);
    expect(state.nextImmediateAction).not.toContain("Untrusted summary heading");
    expect(Object.keys(state.customSections!)).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
