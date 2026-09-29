import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS,
  chatGptMcpInvocationTimeout,
} from "../src/adapters/chatgpt-web/mcp-server";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const dummyEnvironment: ChatGptTurnEnvironment = {
  cwd: "/workspace",
  roots: ["/workspace"],
  writableRoots: ["/workspace"],
  sandboxPolicy: { type: "dangerFullAccess" },
  tools: [],
};

describe("Sprint C: Keep-Alive SSE Heartbeats & Long-Running Command Streaming Resilience", () => {
  describe("Dynamic Invocation Timeout for Long Commands", () => {
    test("returns default 45s timeout when requested timeout is omitted and expiresAt is undefined", () => {
      const timeout = chatGptMcpInvocationTimeout(dummyEnvironment);
      expect(timeout).toBe(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS);
      expect(timeout).toBe(45_000);
    });

    test("clamps to expiresAt if remaining time is less than default 45s", () => {
      const now = 1_000_000;
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 20_000 },
        now,
      );
      expect(timeout).toBe(20_000);
    });

    test("caps long requested waits below the transport deadline", () => {
      const requestedTimeoutMs = 180_000;
      const timeout = chatGptMcpInvocationTimeout(
        dummyEnvironment,
        Date.now(),
        requestedTimeoutMs,
      );
      expect(timeout).toBe(45_000);
    });

    test("turn TTL cannot expand the transport deadline", () => {
      const now = 1_000_000;
      const requestedTimeoutMs = 315_000; // 300s yield + 15s grace
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 600_000 }, // 10 min turn TTL
        now,
        requestedTimeoutMs,
      );
      expect(timeout).toBe(45_000);
    });

    test("transport cap applies even when the turn has two minutes remaining", () => {
      const now = 1_000_000;
      const requestedTimeoutMs = 315_000;
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 120_000 }, // only 2 min remaining
        now,
        requestedTimeoutMs,
      );
      expect(timeout).toBe(45_000);
    });

    test("a short native session yield retires a stalled MCP call before the transport deadline", () => {
      const requestedTimeoutMs = 20_000; // 5s yield + 15s grace
      const timeout = chatGptMcpInvocationTimeout(
        dummyEnvironment,
        Date.now(),
        requestedTimeoutMs,
      );
      expect(timeout).toBe(20_000);
    });
  });

  describe("SSE Keep-Alive Stream Framing", () => {
    test("checkpoint milestones are distinct from transport heartbeats", async () => {
      async function* events(): AsyncGenerator<AdapterEvent> {
        yield { type: "heartbeat" };
        yield {
          type: "milestone",
          kind: "checkpoint_completed",
          result: "Checkpoint validated",
          evidence: "structured_state_and_source_invariants",
          nextStep: "Continue the task",
        };
        yield { type: "done", endTurn: true };
      }

      const body = await new Response(bridgeToResponsesSSE(events(), "chatgpt-web/test")).text();
      expect(body).toContain("event: response.heartbeat");
      expect(body).toContain("event: response.milestone");
      expect(body).toContain("Checkpoint validated");
      expect(body).not.toContain("response.output_text.delta");
    });

    test("adapter heartbeat events emit raw SSE comment : keep-alive and response.heartbeat", async () => {
      async function* heartbeatStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "heartbeat" };
        yield { type: "text_delta", text: "hello after heartbeat" };
        yield { type: "done", endTurn: true };
      }

      const stream = bridgeToResponsesSSE(
        heartbeatStream(),
        "chatgpt-web/test",
        undefined,
        undefined,
        undefined,
        undefined,
        10_000,
      );

      const body = await new Response(stream).text();
      expect(body).toContain(": keep-alive\n\nevent: response.heartbeat\ndata: {\"type\":\"response.heartbeat\"}\n\n");
      expect(body).toContain("hello after heartbeat");
      expect(body).toContain("event: response.completed");
    });

    test("bridge background timer emits keep-alive and heartbeat during upstream silence", async () => {
      async function* slowStream(): AsyncGenerator<AdapterEvent> {
        await sleep(50);
        yield { type: "text_delta", text: "delayed response" };
        yield { type: "done", endTurn: true };
      }

      // Heartbeat timer set to 10ms so it fires during the 50ms pause
      const stream = bridgeToResponsesSSE(
        slowStream(),
        "chatgpt-web/test",
        undefined,
        undefined,
        undefined,
        undefined,
        10,
        { stallTimeoutSec: 10 },
      );

      const body = await new Response(stream).text();
      expect(body).toContain(": keep-alive");
      expect(body).toContain("event: response.heartbeat");
      expect(body).toContain("delayed response");
    });

    test("compaction turns forward heartbeats without corrupting single compaction output item", async () => {
      async function* compactionStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "heartbeat" };
        yield { type: "text_delta", text: "Compacted conversation summary" };
        yield { type: "heartbeat" };
        yield { type: "done", endTurn: true };
      }

      const stream = bridgeToResponsesSSE(
        compactionStream(),
        "chatgpt-web/test",
        undefined,
        undefined,
        undefined,
        undefined,
        10_000,
        { compaction: true },
      );

      const body = await new Response(stream).text();
      expect(body).toContain(": keep-alive");
      expect(body).toContain("event: response.heartbeat");
      // Compaction must emit exactly one compaction item and no raw message items
      expect(body).toContain('"type":"compaction"');
      expect(body).not.toContain('"type":"message"');
      expect(body).toContain("event: response.completed");
    });
  });
});


test("MCP timeout configuration remains finite and within the transport budget", async () => {
  const { resolveMcpInvocationTimeout } = await import("../src/adapters/chatgpt-web/mcp/instructions");
  for (const value of [undefined, "", "NaN", "Infinity", "-1", "0", "300000"]) {
    expect(resolveMcpInvocationTimeout(value)).toBe(45_000);
  }
  expect(resolveMcpInvocationTimeout("5000.9")).toBe(5000);
});
