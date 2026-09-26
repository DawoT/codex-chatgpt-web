import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readWorkspaceState,
  writeWorkspaceState,
  defaultWorkspaceState,
  withStateLock,
  withStateLockSync,
  updateWorkspaceState,
  resolveWorkspaceStatePath,
} from "../src/adapters/chatgpt-web/workspace-state";
import { isLongReasoningTurn } from "../src/server";
import { defaultConfig, defaultBrokerEndpoint } from "../src/config";
import { responseRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

describe("Sprint AB: Long-Reasoning Turn Keep-Alive & Concurrency State Mutex", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sprint-ab-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("GAP-06: Concurrency Mutex & Lockfile on STATE.md", () => {
    test("updateWorkspaceState handles 10 concurrent async writers without losing milestones", async () => {
      const statePath = resolveWorkspaceStatePath(tempDir);
      writeWorkspaceState(tempDir, {
        ...defaultWorkspaceState(),
        goal: "Test Concurrency",
        completedMilestones: ["Milestone 0"],
      });

      // Launch 10 concurrent updates appending different milestones
      const tasks = Array.from({ length: 10 }, (_, i) => {
        return updateWorkspaceState(tempDir, current => {
          return {
            ...current,
            completedMilestones: [...current.completedMilestones, `Milestone ${i + 1}`],
          };
        });
      });

      await Promise.all(tasks);

      const finalState = readWorkspaceState(tempDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.completedMilestones).toHaveLength(11);
      for (let i = 0; i <= 10; i++) {
        expect(finalState!.completedMilestones).toContain(`Milestone ${i}`);
      }
    });

    test("withStateLock acquires and releases .state.lock", async () => {
      const lockPath = join(tempDir, ".agents", ".state.lock");
      mkdirSync(join(tempDir, ".agents"), { recursive: true });

      let wasInsideLock = false;
      await withStateLock(tempDir, async () => {
        expect(existsSync(lockPath)).toBe(true);
        wasInsideLock = true;
      });

      expect(wasInsideLock).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    test("withStateLock detects and breaks stale locks older than staleLockTtlMs", async () => {
      const lockPath = join(tempDir, ".agents", ".state.lock");
      mkdirSync(join(tempDir, ".agents"), { recursive: true });

      // Create an orphaned stale lockfile from an old epoch
      writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: Date.now() - 30_000 }), "utf-8");
      // Set mtime to 30 seconds ago
      const pastTime = (Date.now() - 30_000) / 1000;
      try { utimesSync(lockPath, pastTime, pastTime); } catch {}

      let acquired = false;
      await withStateLock(tempDir, async () => {
        acquired = true;
      }, { staleLockTtlMs: 2_000 });

      expect(acquired).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });

    test("withStateLockSync synchronizes synchronous execution", () => {
      const lockPath = join(tempDir, ".agents", ".state.lock");
      mkdirSync(join(tempDir, ".agents"), { recursive: true });

      let syncRan = false;
      withStateLockSync(tempDir, () => {
        expect(existsSync(lockPath)).toBe(true);
        syncRan = true;
      });

      expect(syncRan).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("GAP-05: Long-Reasoning Turn Keep-Alive & Heartbeats", () => {
    test("isLongReasoningTurn accurately detects high and max reasoning configurations", () => {
      const mockReq = (modelId: string, reasoning?: string): CodexParsedRequest => ({
        modelId,
        stream: false,
        context: { messages: [] },
        options: { reasoning },
      });

      expect(isLongReasoningTurn(mockReq("chatgpt-web", "high"))).toBe(true);
      expect(isLongReasoningTurn(mockReq("chatgpt-web", "max"))).toBe(true);
      expect(isLongReasoningTurn(mockReq("chatgpt-web/high"))).toBe(true);
      expect(isLongReasoningTurn(mockReq("chatgpt-web/max"))).toBe(true);
      expect(isLongReasoningTurn(mockReq("gpt-5.6-high"))).toBe(true);

      // Low, medium, or unspecified are not long-reasoning forced stream
      expect(isLongReasoningTurn(mockReq("chatgpt-web", "medium"))).toBe(false);
      expect(isLongReasoningTurn(mockReq("chatgpt-web", "low"))).toBe(false);
      expect(isLongReasoningTurn(mockReq("chatgpt-web"))).toBe(false);
    });

    test("responseRequest rejects non-streaming high-reasoning turn with 400 to prevent proxy 504 timeout", async () => {
      const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(tempDir) };
      const body = {
        model: "chatgpt-web/high",
        stream: false,
        reasoning: { effort: "high" },
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Complex mathematical theorem proof" }] },
        ],
      };

      const req = new Request("http://127.0.0.1:17841/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const res = await responseRequest(req, config);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBeDefined();
      expect(json.error.type).toBe("invalid_request_error");
      expect(json.error.message).toContain("requires stream: true for long-reasoning turns");
    });
  });
});
