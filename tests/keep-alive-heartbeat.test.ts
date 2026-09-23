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
    test("returns default 90s timeout when requested timeout is omitted and expiresAt is undefined", () => {
      const timeout = chatGptMcpInvocationTimeout(dummyEnvironment);
      expect(timeout).toBe(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS);
      expect(timeout).toBe(90_000);
    });

    test("clamps to expiresAt if remaining time is less than default 90s", () => {
      const now = 1_000_000;
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 45_000 },
        now,
      );
      expect(timeout).toBe(45_000);
    });

    test("dynamically accommodates long yield_time_ms (e.g. 180s) when expiresAt is undefined", () => {
      const requestedTimeoutMs = 180_000;
      const timeout = chatGptMcpInvocationTimeout(
        dummyEnvironment,
        Date.now(),
        requestedTimeoutMs,
      );
      expect(timeout).toBe(180_000);
    });

    test("dynamically accommodates long yield_time_ms (e.g. 300s) within a longer turn TTL", () => {
      const now = 1_000_000;
      const requestedTimeoutMs = 315_000; // 300s yield + 15s grace
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 600_000 }, // 10 min turn TTL
        now,
        requestedTimeoutMs,
      );
      expect(timeout).toBe(315_000);
    });

    test("caps requested timeout to remaining turn TTL if TTL expires sooner", () => {
      const now = 1_000_000;
      const requestedTimeoutMs = 315_000;
      const timeout = chatGptMcpInvocationTimeout(
        { ...dummyEnvironment, expiresAt: now + 120_000 }, // only 2 min remaining
        now,
        requestedTimeoutMs,
      );
      expect(timeout).toBe(120_000);
    });

    test("does not shrink below default 90s if requested timeout is shorter (e.g. 5s yield)", () => {
      const requestedTimeoutMs = 20_000; // 5s yield + 15s grace
      const timeout = chatGptMcpInvocationTimeout(
        dummyEnvironment,
        Date.now(),
        requestedTimeoutMs,
      );
      expect(timeout).toBe(90_000);
    });
  });

  describe("SSE Keep-Alive Stream Framing", () => {
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
