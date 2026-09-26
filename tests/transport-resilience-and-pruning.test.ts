import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { modelsRequest, startServer } from "../src/server";
import {
  collectCodexRolloutFiles,
  pruneCodexSessions,
  type CodexRolloutFileInfo,
  type CodexSessionPruningOptions,
} from "../src/adapters/chatgpt-web/session-store-pruner";

describe("Sprint AC: Transport Resilience & Session Store Pruning", () => {
  const testDir = join(process.cwd(), ".agents", "scratch", "test-sessions-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Transport Layer: Route Probes & Error Mapping", () => {
    test("modelsRequest returns 502 upstream_error when Authorization header is missing", async () => {
      const request = new Request("http://127.0.0.1:17841/v1/models", {
        headers: { "user-agent": "codex_cli_rs/0.156.1" },
      });
      const config = defaultConfig("full");
      let upstreamCalled = false;

      const response = await modelsRequest(request, config, async () => {
        upstreamCalled = true;
        return Response.json({ models: [] });
      });

      expect(upstreamCalled).toBe(false);
      expect(response.status).toBe(502);
      const data = await response.json() as { error: { message: string; type: string; code: string } };
      expect(data.error.type).toBe("server_error");
      expect(data.error.message).toContain("Bearer authorization");
    });

    test("modelsRequest returns 502 upstream_error when Authorization header is invalid", async () => {
      const request = new Request("http://127.0.0.1:17841/v1/models", {
        headers: { authorization: "Basic invalid-creds" },
      });
      const config = defaultConfig("full");
      let upstreamCalled = false;

      const response = await modelsRequest(request, config, async () => {
        upstreamCalled = true;
        return Response.json({ models: [] });
      });

      expect(upstreamCalled).toBe(false);
      expect(response.status).toBe(502);
      const data = await response.json() as { error: { message: string; type: string; code: string } };
      expect(data.error.type).toBe("server_error");
    });

    test("modelsRequest returns 200 and forwards when valid Bearer token is provided", async () => {
      const request = new Request("http://127.0.0.1:17841/v1/models", {
        headers: { authorization: "Bearer valid-token" },
      });
      const config = defaultConfig("full");
      config.subagentProtocol = "native";
      let upstreamCalled = false;

      const response = await modelsRequest(request, config, async req => {
        upstreamCalled = true;
        expect(req.headers.get("authorization")).toBe("Bearer valid-token");
        return Response.json({
          models: [{
            slug: "gpt-5.6-sol",
            display_name: "5.6 Sol",
            priority: 1,
            visibility: "list",
            supported_in_api: true,
            multi_agent_version: "v2",
            supported_reasoning_levels: [],
            tool_mode: "code_mode_only",
            context_window: 300_000,
            max_context_window: 320_000,
            auto_compact_token_limit: 270_000,
          }],
        });
      });

      expect(upstreamCalled).toBe(true);
      expect(response.status).toBe(200);
      const data = await response.json() as { models: Array<{ slug: string }> };
      expect(data.models.some(m => m.slug === "gpt-5.6-sol")).toBe(true);
    });

    test("startServer responds to HEAD /v1/responses with 200 OK and connection headers", async () => {
      const config = defaultConfig("browser-only");
      config.port = 17899;
      config.host = "127.0.0.1";
      const server = startServer(config);

      try {
        const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
          method: "HEAD",
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("connection")).toBe("keep-alive");
        expect(res.headers.get("allow")).toContain("HEAD");
      } finally {
        server.stop(true);
      }
    });

    test("startServer responds to GET /v1/responses with 426 and RFC-compliant WebSocket demotion headers", async () => {
      const config = defaultConfig("browser-only");
      config.port = 17898;
      config.host = "127.0.0.1";
      const server = startServer(config);

      try {
        const res = await fetch(`http://127.0.0.1:${config.port}/v1/responses`, {
          method: "GET",
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Sec-WebSocket-Version": "13",
          },
        });
        expect(res.status).toBe(426);
        expect(res.headers.get("upgrade")).toBe("HTTP/1.1");
        expect(res.headers.get("connection")).toBe("Upgrade");
        expect(res.headers.get("sec-websocket-version")).toBe("13");
        expect(res.headers.get("x-responses-transport")).toBe("sse-required");
        const bodyText = await res.text();
        expect(bodyText).toContain("Responses WebSocket transport is not enabled");
      } finally {
        server.stop(true);
      }
    });
  });

  describe("Session Store Pruning Utility", () => {
    function createMockRollout(
      relPath: string,
      meta: { sessionId: string; source: string; timestamp: string },
      contentSizeBytes: number,
      mtimeOffsetMs: number = 0,
    ): string {
      const fullPath = join(testDir, relPath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      const firstLine = JSON.stringify({
        timestamp: meta.timestamp,
        ordinal: 0,
        type: "session_meta",
        payload: {
          session_id: meta.sessionId,
          source: meta.source,
          timestamp: meta.timestamp,
        },
      });
      const padding = "x".repeat(Math.max(0, contentSizeBytes - firstLine.length - 1));
      writeFileSync(fullPath, `${firstLine}\n${padding}`, "utf8");

      if (mtimeOffsetMs !== 0) {
        const utime = new Date(Date.now() - mtimeOffsetMs);
        const { utimesSync } = require("node:fs");
        utimesSync(fullPath, utime, utime);
      }
      return fullPath;
    }

    test("collectCodexRolloutFiles recursively discovers rollouts across nested YYYY/MM/DD paths", () => {
      createMockRollout(
        "2026/09/20/rollout-2026-09-20T10-00-00-01a01111.jsonl",
        { sessionId: "s1", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        1000,
      );
      createMockRollout(
        "2026/09/24/rollout-2026-09-24T12-00-00-01a02222.jsonl",
        { sessionId: "s2", source: "exec", timestamp: "2026-09-24T12:00:00Z" },
        2000,
      );

      const rollouts = collectCodexRolloutFiles(testDir);
      expect(rollouts.length).toBe(2);
      expect(rollouts.some(r => r.sessionId === "s1" && r.source === "subagent:thread_spawn")).toBe(true);
      expect(rollouts.some(r => r.sessionId === "s2" && r.source === "exec")).toBe(true);
    });

    test("pruneCodexSessions respects protectRecentMs invariant", () => {
      // Create a recent file (modified just now)
      createMockRollout(
        "2026/09/24/rollout-recent.jsonl",
        { sessionId: "s-recent", source: "subagent:thread_spawn", timestamp: new Date().toISOString() },
        5000,
        0, // 0 offset = now
      );
      // Create an old file (modified 2 hours ago)
      createMockRollout(
        "2026/09/24/rollout-old.jsonl",
        { sessionId: "s-old", source: "subagent:thread_spawn", timestamp: new Date(Date.now() - 7_200_000).toISOString() },
        5000,
        7_200_000, // 2 hours old
      );

      const result = pruneCodexSessions({
        sessionsDir: testDir,
        maxFiles: 1, // Only allow 1 file
        protectRecentMs: 3_600_000, // Protect last 1 hour
      });

      expect(result.scannedFiles).toBe(2);
      expect(result.prunedFiles.length).toBe(1);
      expect(result.prunedFiles[0].sessionId).toBe("s-old");
      expect(result.remainingFiles).toBe(1);
      expect(existsSync(join(testDir, "2026/09/24/rollout-recent.jsonl"))).toBe(true);
      expect(existsSync(join(testDir, "2026/09/24/rollout-old.jsonl"))).toBe(false);
    });

    test("pruneCodexSessions enforces maxTotalBytes threshold in FIFO order", () => {
      // 3 files of 10,000 bytes each, total 30,000 bytes
      createMockRollout(
        "2026/09/20/rollout-oldest.jsonl",
        { sessionId: "s-oldest", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        10_000,
        3 * 86_400_000, // 3 days old
      );
      createMockRollout(
        "2026/09/21/rollout-middle.jsonl",
        { sessionId: "s-middle", source: "subagent:thread_spawn", timestamp: "2026-09-21T10:00:00Z" },
        10_000,
        2 * 86_400_000, // 2 days old
      );
      createMockRollout(
        "2026/09/22/rollout-newest.jsonl",
        { sessionId: "s-newest", source: "subagent:thread_spawn", timestamp: "2026-09-22T10:00:00Z" },
        10_000,
        86_400_000, // 1 day old
      );

      // We want max 15,000 bytes. The oldest 2 files should be pruned, leaving s-newest.
      const result = pruneCodexSessions({
        sessionsDir: testDir,
        maxTotalBytes: 15_000,
        protectRecentMs: 3_600_000,
      });

      expect(result.prunedFiles.length).toBe(2);
      expect(result.prunedFiles.map(f => f.sessionId)).toEqual(["s-oldest", "s-middle"]);
      expect(result.reclaimedBytes).toBeGreaterThanOrEqual(20_000);
      expect(result.remainingFiles).toBe(1);
    });

    test("pruneCodexSessions targets specific sources (subagent:*) while preserving interactive sessions", () => {
      createMockRollout(
        "2026/09/20/rollout-subagent.jsonl",
        { sessionId: "s-subagent", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        50_000,
        2 * 86_400_000,
      );
      createMockRollout(
        "2026/09/20/rollout-vscode.jsonl",
        { sessionId: "s-vscode", source: "vscode", timestamp: "2026-09-20T10:00:00Z" },
        50_000,
        2 * 86_400_000,
      );

      const result = pruneCodexSessions({
        sessionsDir: testDir,
        maxFiles: 1,
        targetSources: ["subagent:thread_spawn", "subagent:other"],
        protectRecentMs: 3_600_000,
      });

      expect(result.prunedFiles.length).toBe(1);
      expect(result.prunedFiles[0].sessionId).toBe("s-subagent");
      expect(existsSync(join(testDir, "2026/09/20/rollout-vscode.jsonl"))).toBe(true);
    });

    test("pruneCodexSessions dryRun mode reports planned deletions without modifying disk", () => {
      createMockRollout(
        "2026/09/20/rollout-dryrun.jsonl",
        { sessionId: "s-dry", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        10_000,
        2 * 86_400_000,
      );

      const result = pruneCodexSessions({
        sessionsDir: testDir,
        maxFiles: 0, // prune all eligible
        dryRun: true,
        protectRecentMs: 3_600_000,
      });

      expect(result.dryRun).toBe(true);
      expect(result.prunedFiles.length).toBe(1);
      expect(result.prunedFiles[0].sessionId).toBe("s-dry");
      // File must still exist on disk
      expect(existsSync(join(testDir, "2026/09/20/rollout-dryrun.jsonl"))).toBe(true);
    });

    test("pruneCodexSessions cleans up empty parent directories after pruning", () => {
      createMockRollout(
        "2026/09/15/rollout-old.jsonl",
        { sessionId: "s-cleanup", source: "subagent:thread_spawn", timestamp: "2026-09-15T10:00:00Z" },
        5_000,
        10 * 86_400_000,
      );

      expect(existsSync(join(testDir, "2026/09/15"))).toBe(true);

      const result = pruneCodexSessions({
        sessionsDir: testDir,
        maxAgeMs: 5 * 86_400_000, // 5 days
        protectRecentMs: 3_600_000,
        removeEmptyDirs: true,
      });

      expect(result.prunedFiles.length).toBe(1);
      expect(existsSync(join(testDir, "2026/09/15"))).toBe(false);
      expect(existsSync(join(testDir, "2026"))).toBe(false);
    });
  });
});
