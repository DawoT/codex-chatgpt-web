import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCompactionFlow } from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser/suspension-clock";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function createMockCompactionRequest(suffix = "1"): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    context: {
      messages: [
        { role: "user", content: "Original goal", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Goal in progress" }], timestamp: 2 },
      ],
    },
    stream: false,
    options: { reasoning: "medium" },
    _compactionRequest: true,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Original goal" }],
          internal_chat_message_metadata_passthrough: { turn_id: `turn_source_${suffix}` },
        },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: `thread_transparency_${suffix}`,
          turn_id: `turn_transparency_${suffix}`,
        }),
      },
    },
  };
}

test("executeCompactionFlow preserves exact message and code on ChatGptBrowserObservationTimeoutError without masking", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-transparency-"));
  const parsed = createMockCompactionRequest();
  const events: AdapterEvent[] = [];

  try {
    await executeCompactionFlow({
      worker: {
        run: async () => {
          throw new ChatGptBrowserObservationTimeoutError(5250);
        },
      } as any,
      parsed,
      incoming: { headers: new Headers() },
      emit: (e: AdapterEvent) => events.push(e),
      configuredCapabilities: {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: true,
      },
      turnCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      manualRequest: false,
      retainedLauncherDescriptor: "launcher-descriptor",
      experimentalBiggerContext: false,
      experimentalSkillAttachments: false,
      structuredBroker: {
        beginCompactionTransaction: async () => ({ token: "control_1", handoffId: "handoff_1" }),
        waitForCompactionHandoff: async () => {
          throw new Error("retained handoff failed");
        },
        abortCompactionTransaction() {},
      } as any,
      broker: {} as any,
      executionNamespace: root,
      timeoutMs: 10_000,
      freshConversationPerTurn: false,
      retryKey: "retry-key",
      environment: undefined,
      startRuntime: () => {
        return {
          browser: Promise.reject(new ChatGptBrowserObservationTimeoutError(5250)),
          physicalSettlement: Promise.resolve(),
          cancel() {},
        } as any;
      },
    });

    const errorEvent = events.find((e) => e.type === "error") as any;
    expect(errorEvent).toBeDefined();
    // Must NOT be the masked fallback "ChatGPT did not complete the context handoff. Retry the task."
    expect(errorEvent.message).toBe("ChatGPT browser DOM observation did not respond within 5250ms");
    expect(errorEvent.code).toBe("browser_dom_observation_timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executeCompactionFlow preserves arbitrary untyped Error messages rather than masking", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-transparency-untyped-"));
  const parsed = createMockCompactionRequest("2");
  const events: AdapterEvent[] = [];

  try {
    await executeCompactionFlow({
      worker: {
        run: async () => {
          throw new Error("Chromium renderer disconnect: transport closed");
        },
      } as any,
      parsed,
      incoming: { headers: new Headers() },
      emit: (e: AdapterEvent) => events.push(e),
      configuredCapabilities: {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: true,
      },
      turnCapabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      manualRequest: false,
      retainedLauncherDescriptor: "launcher-descriptor",
      experimentalBiggerContext: false,
      experimentalSkillAttachments: false,
      structuredBroker: {
        beginCompactionTransaction: async () => ({ token: "control_1", handoffId: "handoff_1" }),
        waitForCompactionHandoff: async () => {
          throw new Error("retained handoff failed");
        },
        abortCompactionTransaction() {},
      } as any,
      broker: {} as any,
      executionNamespace: root,
      timeoutMs: 10_000,
      freshConversationPerTurn: false,
      retryKey: "retry-key",
      environment: undefined,
      startRuntime: () => {
        return {
          browser: Promise.reject(new Error("Chromium renderer disconnect: transport closed")),
          physicalSettlement: Promise.resolve(),
          cancel() {},
        } as any;
      },
    });

    const errorEvent = events.find((e) => e.type === "error") as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("Chromium renderer disconnect: transport closed");
    expect(errorEvent.code).toBe("compaction_handoff_failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
