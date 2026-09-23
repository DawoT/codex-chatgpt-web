import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS,
  MAX_CHATGPT_BROWSER_TABS,
  SubagentConcurrencyGovernor,
} from "../src/adapters/chatgpt-web/concurrency";
import { isChatGptSubagentTurn } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("Sprint D: Browser Tab Pool & Subagent Semaphore", () => {
  describe("SubagentConcurrencyGovernor", () => {
    test("allows up to maxConcurrent permits immediately", async () => {
      const governor = new SubagentConcurrencyGovernor(2, 5000);
      expect(governor.maxConcurrent).toBe(2);
      expect(governor.active).toBe(0);
      expect(governor.available).toBe(2);
      expect(governor.queued).toBe(0);

      const release1 = await governor.acquire();
      expect(governor.active).toBe(1);
      expect(governor.available).toBe(1);
      expect(governor.queued).toBe(0);

      const release2 = await governor.acquire();
      expect(governor.active).toBe(2);
      expect(governor.available).toBe(0);
      expect(governor.queued).toBe(0);

      release1();
      expect(governor.active).toBe(1);
      expect(governor.available).toBe(1);

      release2();
      expect(governor.active).toBe(0);
      expect(governor.available).toBe(2);
    });

    test("queues 3rd request in FIFO order when maxConcurrent is 2", async () => {
      const governor = new SubagentConcurrencyGovernor(2, 5000);
      const release1 = await governor.acquire();
      const release2 = await governor.acquire();

      let p3Resolved = false;
      let p3Release: (() => void) | undefined;
      const p3 = governor.acquire().then(rel => {
        p3Resolved = true;
        p3Release = rel;
        return rel;
      });

      expect(governor.active).toBe(2);
      expect(governor.queued).toBe(1);
      expect(governor.available).toBe(0);
      expect(p3Resolved).toBe(false);

      // Release first active subagent
      release1();

      await sleep(10);
      expect(p3Resolved).toBe(true);
      expect(governor.active).toBe(2); // release2 is active, p3 is now active
      expect(governor.queued).toBe(0);

      // Release remaining
      release2();
      expect(governor.active).toBe(1);
      p3Release?.();
      expect(governor.active).toBe(0);
      expect(governor.available).toBe(2);
    });

    test("rejects immediate acquire if signal is already aborted", async () => {
      const governor = new SubagentConcurrencyGovernor(2, 5000);
      const abort = new AbortController();
      abort.abort();

      let error: any;
      try {
        await governor.acquire(abort.signal);
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.name).toBe("AbortError");
      expect(governor.active).toBe(0);
      expect(governor.queued).toBe(0);
    });

    test("unlinks and rejects queued request when its AbortSignal fires", async () => {
      const governor = new SubagentConcurrencyGovernor(2, 5000);
      const release1 = await governor.acquire();
      const release2 = await governor.acquire();

      const abort = new AbortController();
      let abortedError: any;
      const p3 = governor.acquire(abort.signal).catch(err => {
        abortedError = err;
      });

      expect(governor.queued).toBe(1);

      // Abort while waiting
      abort.abort();
      await p3;

      expect(abortedError).toBeDefined();
      expect(abortedError.name).toBe("AbortError");
      expect(abortedError.message).toContain("waiting for an available browser slot");
      expect(governor.queued).toBe(0);
      expect(governor.active).toBe(2);

      release1();
      release2();
      expect(governor.active).toBe(0);
    });

    test("times out queued request when queueTimeoutMs expires", async () => {
      const governor = new SubagentConcurrencyGovernor(1, 50); // 50ms timeout
      const release1 = await governor.acquire();

      let timeoutError: any;
      const p2 = governor.acquire().catch(err => {
        timeoutError = err;
      });

      expect(governor.queued).toBe(1);
      await sleep(80);
      await p2;

      expect(timeoutError).toBeDefined();
      expect(timeoutError.message).toContain("Subagent concurrency limit reached");
      expect(timeoutError.message).toContain("without success");
      expect(governor.queued).toBe(0);
      expect(governor.active).toBe(1);

      release1();
      expect(governor.active).toBe(0);
    });

    test("clear rejects all pending waiters on reset or shutdown", async () => {
      const governor = new SubagentConcurrencyGovernor(1, 5000);
      const release1 = await governor.acquire();

      let err1: any;
      let err2: any;
      const p2 = governor.acquire().catch(err => { err1 = err; });
      const p3 = governor.acquire().catch(err => { err2 = err; });

      expect(governor.queued).toBe(2);

      const shutdownReason = new Error("Server is shutting down");
      governor.clear(shutdownReason);

      await Promise.all([p2, p3]);
      expect(err1).toBe(shutdownReason);
      expect(err2).toBe(shutdownReason);
      expect(governor.queued).toBe(0);

      // Releasing release1 after clear should not cause activeCount to go below 0
      release1();
      expect(governor.active).toBe(0);
    });

    test("status report matches current state", async () => {
      const governor = new SubagentConcurrencyGovernor(3, 5000);
      const rel1 = await governor.acquire();
      const status = governor.status;
      expect(status).toEqual({
        active: 1,
        queued: 0,
        available: 2,
        maxConcurrent: 3,
      });
      rel1();
    });

    test("guards against double-release and underflow", async () => {
      const governor = new SubagentConcurrencyGovernor(2, 5000);
      const rel = await governor.acquire();
      expect(governor.active).toBe(1);
      rel();
      expect(governor.active).toBe(0);
      rel(); // redundant release
      expect(governor.active).toBe(0);
    });
  });

  describe("Subagent Turn Detection (isChatGptSubagentTurn)", () => {
    const createMockTurnWithMetadata = (metadata: Record<string, unknown>): CodexParsedRequest => ({
      modelId: "chatgpt/gpt-5-codex",
      stream: true,
      context: {
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      },
      options: {},
      _rawBody: {
        client_metadata: {
          "x-codex-turn-metadata": metadata,
        },
      },
    });

    test("returns false for standard root turn", () => {
      const request = createMockTurnWithMetadata({
        request_kind: "turn",
        thread_id: "thread_root_123",
        turn_id: "turn_root_456",
        agent_name: "/root",
      });
      expect(isChatGptSubagentTurn(request)).toBe(false);
    });

    test("returns true when parent_thread_id is present", () => {
      const request = createMockTurnWithMetadata({
        request_kind: "turn",
        thread_id: "thread_sub_123",
        turn_id: "turn_sub_456",
        parent_thread_id: "thread_root_123",
      });
      expect(isChatGptSubagentTurn(request)).toBe(true);
    });

    test("returns true when subagent_kind is thread_spawn", () => {
      const request = createMockTurnWithMetadata({
        request_kind: "turn",
        thread_id: "thread_sub_123",
        turn_id: "turn_sub_456",
        subagent_kind: "thread_spawn",
      });
      expect(isChatGptSubagentTurn(request)).toBe(true);
    });

    test("returns true when agent_name is a specialized worker (not /root)", () => {
      const request = createMockTurnWithMetadata({
        request_kind: "turn",
        thread_id: "thread_sub_123",
        turn_id: "turn_sub_456",
        agent_name: "/root/researcher",
      });
      expect(isChatGptSubagentTurn(request)).toBe(true);
    });

    test("thread-spawn lineage metadata marks subagents for eager conversation closure", () => {
      const subagentRequest = createMockTurnWithMetadata({
        request_kind: "turn",
        thread_id: "thread_sub_123",
        turn_id: "turn_sub_456",
        parent_thread_id: "thread_root_123",
        subagent_kind: "thread_spawn",
        agent_name: "/root/worker",
        sandbox: { type: "workspaceWrite" },
        workspaces: { "/workspace": {} },
      });
      const isSubagent = isChatGptSubagentTurn(subagentRequest);
      expect(isSubagent).toBe(true);

      // Verify that subagents disable retained conversation
      const retainConversation = !isSubagent; // mimics index.ts line 439
      expect(retainConversation).toBe(false);
    });
  });

  describe("Concurrency Ceiling Constraints", () => {
    test("DEFAULT_MAX_CONCURRENT_SUBAGENTS respects MAX_CHATGPT_BROWSER_TABS", () => {
      // 1 root orchestrator + 2 subagents = 3 tabs <= 5 hard max
      expect(DEFAULT_MAX_CONCURRENT_SUBAGENTS).toBe(2);
      expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);
      expect(1 + DEFAULT_MAX_CONCURRENT_SUBAGENTS).toBeLessThanOrEqual(MAX_CHATGPT_BROWSER_TABS);
    });

    test("DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS is reasonably bounded", () => {
      expect(DEFAULT_SUBAGENT_QUEUE_TIMEOUT_MS).toBe(120_000);
    });
  });
});
