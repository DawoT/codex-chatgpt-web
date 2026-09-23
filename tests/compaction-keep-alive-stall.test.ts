import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_ADAPTER_HEARTBEAT_MS,
  CHATGPT_WEB_COMPACTION_HEARTBEAT_MS,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

describe("Sprint M: SSE Early-Ack & Accelerated Compaction Heartbeats", () => {
  test("constants reflect accelerated cadence for compaction", () => {
    expect(CHATGPT_WEB_ADAPTER_HEARTBEAT_MS).toBe(10_000);
    expect(CHATGPT_WEB_COMPACTION_HEARTBEAT_MS).toBe(3_000);
    expect(CHATGPT_WEB_COMPACTION_HEARTBEAT_MS).toBeLessThan(CHATGPT_WEB_ADAPTER_HEARTBEAT_MS);
  });

  test("compaction heartbeats keep the SSE stream alive and refresh silence timer", async () => {
    async function* makeEvents(): AsyncGenerator<AdapterEvent> {
      yield { type: "heartbeat" };
      await Bun.sleep(50);
      yield { type: "heartbeat" };
      await Bun.sleep(50);
      yield { type: "text_delta", text: "Summary of earlier task context" };
      yield { type: "done", stopReason: "stop", endTurn: true };
    }

    const stream = bridgeToResponsesSSE(
      makeEvents(),
      "chatgpt-web",
      undefined,
      undefined,
      undefined,
      undefined,
      500, // heartbeat interval
      {
        compaction: true,
        stallTimeoutSec: 2, // 2s stall budget
      },
    );

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let aggregated = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      aggregated += decoder.decode(value, { stream: true });
    }

    // Must contain keep-alive comments and response.heartbeat events
    expect(aggregated).toContain(": keep-alive");
    expect(aggregated).toContain("response.heartbeat");

    // Must contain the single synthetic compaction item (and NO assistant message output items)
    expect(aggregated).toContain("\"type\":\"compaction\"");
    expect(aggregated).toContain("ocx1:");
    expect(aggregated).not.toContain("\"type\":\"message\"");
    expect(aggregated).toContain("[DONE]");
  });

  test("adapter emits accelerated heartbeats during compaction turn waiting period", async () => {
    const provider = {
      adapter: "chatgpt-web" as const,
      baseUrl: "browser://test",
      chatgptWeb: {
        browserHost: "launcher" as const,
        browserHostDescriptorPath: "/tmp/launcher.json",
        localToolsEnabled: true,
      },
    };

    const adapter = createChatGptWebAdapter(provider);
    const parsed: CodexParsedRequest = {
      modelId: "chatgpt-web",
      stream: true,
      options: {},
      context: { messages: [] },
      _compactionRequest: true,
    };

    const emittedEvents: AdapterEvent[] = [];
    const abortController = new AbortController();

    // Abort after 50ms to test early initialization heartbeats without starting full browser
    setTimeout(() => abortController.abort(), 40);

    try {
      await adapter.runTurn!(
        parsed,
        { headers: new Headers(), abortSignal: abortController.signal },
        event => emittedEvents.push(event),
      );
    } catch {
      // expected abort
    }

    // An initial heartbeat must have been emitted immediately before any awaited work
    expect(emittedEvents.some(e => e.type === "heartbeat")).toBeTrue();
  });
});
