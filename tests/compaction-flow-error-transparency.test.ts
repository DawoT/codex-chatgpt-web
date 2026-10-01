import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCompactionFlow } from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser/suspension-clock";
import { serializeDiagnosticError, snapshotDiagnosticEvents } from "../src/diagnostics";
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

test("executeCompactionFlow masks arbitrary details and preserves a correlated cause without exposing the raw error", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-transparency-untyped-"));
  const parsed = createMockCompactionRequest("2");
  const events: AdapterEvent[] = [];
  const rawError = "Chromium renderer disconnect: transport closed";
  const sourceError = new Error(rawError);
  const errorLogs: string[] = [];
  const infoSpy = spyOn(console, "info").mockImplementation((line) => errorLogs.push(String(line)));
  const errorSpy = spyOn(console, "error").mockImplementation((...parts) => {
    errorLogs.push(parts.map(String).join(" "));
  });

  try {
    await executeCompactionFlow({
      worker: {
        run: async () => {
          throw sourceError;
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
          browser: Promise.reject(sourceError),
          physicalSettlement: Promise.resolve(),
          cancel() {},
        } as any;
      },
    });

    const errorEvent = events.find((e) => e.type === "error") as any;
    expect(errorEvent).toBeDefined();
    // Cause identity remains available while arbitrary text stays out of both channels.
    expect(errorEvent.message).toBe("ChatGPT did not complete the context handoff. Retry the task.");
    expect(errorEvent.code).toBe("compaction_handoff_failed");
    expect(JSON.stringify(events)).not.toContain(rawError);
    expect(errorLogs.join("\n")).not.toContain(rawError);
    const failureLine = errorLogs.find(
      (line) => line.startsWith("[chatgpt-web] compaction_event ") && line.includes('"phase":"failed"'),
    )!;
    const traceId = JSON.parse(failureLine.slice("[chatgpt-web] compaction_event ".length)).traceId;
    const timeline = snapshotDiagnosticEvents(traceId).events;
    expect(timeline.some((event) => event.error?.errorId === serializeDiagnosticError(sourceError).errorId)).toBeTrue();
  } finally {
    errorSpy.mockRestore();
    infoSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
