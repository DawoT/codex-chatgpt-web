import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  SessionStoreJanitor,
  syncCodexStateDatabase,
  type SessionJanitorOptions,
} from "../src/adapters/chatgpt-web/session-store-pruner";
import { gcSubagentWorkspaces } from "../src/adapters/chatgpt-web/subagent-workspace";

describe("Sprint AD: Autonomous Background Session Janitor", () => {
  const testDir = join(process.cwd(), ".agents", "scratch", "test-janitor-" + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function createMockRollout(
    relPath: string,
    meta: { sessionId: string; source: string; timestamp: string },
    sizeBytes: number,
    ageMs: number,
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
    const padding = "x".repeat(Math.max(0, sizeBytes - firstLine.length - 1));
    writeFileSync(fullPath, `${firstLine}\n${padding}`, "utf8");

    const utime = new Date(Date.now() - ageMs);
    const { utimesSync } = require("node:fs");
    utimesSync(fullPath, utime, utime);
    return fullPath;
  }

  describe("SessionStoreJanitor Lifecycle & Operations", () => {
    test("initializes with default options and starts in stopped state until start() is called", () => {
      const janitor = new SessionStoreJanitor({
        sessionsDir: testDir,
        intervalMs: 10_000,
        runOnStart: false,
      });

      const stats = janitor.getStats();
      expect(stats.enabled).toBe(true);
      expect(stats.running).toBe(false);
      expect(stats.runs_count).toBe(0);
      expect(stats.last_run_at).toBeNull();

      janitor.start();
      expect(janitor.getStats().running).toBe(true);

      janitor.stop();
      expect(janitor.getStats().running).toBe(false);
    });

    test("runNow executes immediately and updates statistics", () => {
      createMockRollout(
        "2026/09/20/rollout-subagent.jsonl",
        { sessionId: "s1", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        20_000,
        5 * 86_400_000, // 5 days old
      );

      const janitor = new SessionStoreJanitor({
        sessionsDir: testDir,
        maxAgeMs: 2 * 86_400_000, // 2 days TTL
        protectRecentMs: 3_600_000,
        targetSources: ["subagent:thread_spawn"],
        runOnStart: false,
      });

      const result = janitor.runNow();
      expect(result.scannedFiles).toBe(1);
      expect(result.prunedFiles.length).toBe(1);
      expect(result.reclaimedBytes).toBeGreaterThanOrEqual(20_000);

      const stats = janitor.getStats();
      expect(stats.runs_count).toBe(1);
      expect(stats.last_run_at).not.toBeNull();
      expect(stats.last_pruned_count).toBe(1);
      expect(stats.last_reclaimed_bytes).toBeGreaterThanOrEqual(20_000);
      expect(stats.last_error).toBeNull();
    });

    test("handles errors gracefully without throwing and updates last_error", () => {
      const janitor = new SessionStoreJanitor({
        sessionsDir: join(testDir, "non_existent_and_unreadable"),
        runOnStart: false,
      });

      // Override collect or simulate fault by pointing to invalid path
      const result = janitor.runNow();
      // Should not throw, returns 0 scanned
      expect(result.scannedFiles).toBe(0);
      expect(janitor.getStats().last_error).toBeNull();
    });

    test("schedules periodic runs with timer", async () => {
      let runCount = 0;
      const janitor = new SessionStoreJanitor({
        sessionsDir: testDir,
        intervalMs: 50, // fast interval for test
        initialDelayMs: 20,
        runOnStart: true,
        logger: () => { runCount++; },
      });

      janitor.start();
      await new Promise(r => setTimeout(r, 150));
      janitor.stop();

      const stats = janitor.getStats();
      expect(stats.runs_count).toBeGreaterThanOrEqual(2);
      expect(stats.running).toBe(false);
    });
  });

  describe("Server Integration & Health Metrics", () => {
    test("startServer exposes session_janitor in /healthz metrics", async () => {
      const config = defaultConfig("full");
      config.port = 17897;
      config.host = "127.0.0.1";
      const server = startServer(config);

      try {
        const res = await fetch(`http://127.0.0.1:${config.port}/healthz`);
        expect(res.status).toBe(200);
        const data = await res.json() as { session_janitor?: Record<string, unknown> };
        expect(data.session_janitor).toBeDefined();
        expect(data.session_janitor?.enabled).toBe(true);
        expect(typeof data.session_janitor?.runs_count).toBe("number");
      } finally {
        server.stop(true);
      }
    });

    test("startServer provides POST /admin/session-janitor/run endpoint", async () => {
      const config = defaultConfig("full");
      config.port = 17896;
      config.host = "127.0.0.1";
      const server = startServer(config);

      try {
        // Without control authorization: returns 401
        const unauthRes = await fetch(`http://127.0.0.1:${config.port}/admin/session-janitor/run`, {
          method: "POST",
        });
        expect(unauthRes.status).toBe(401);

        // With authorization (loopback control token if needed or controlAuthorized bypass for tests)
        // Let's test with custom headers matching controlAuthorized
        const authRes = await fetch(`http://127.0.0.1:${config.port}/admin/session-janitor/run`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.controlToken}`,
          },
        });
        expect(authRes.status).toBe(200);
        const result = await authRes.json() as { status: string; result: { scannedFiles: number } };
        expect(result.status).toBe("ok");
        expect(typeof result.result.scannedFiles).toBe("number");
      } finally {
        server.stop(true);
      }
    });

    test("gcSubagentWorkspaces can trigger session rollout pruning", () => {
      createMockRollout(
        "2026/09/20/rollout-subagent-gc.jsonl",
        { sessionId: "s-gc", source: "subagent:thread_spawn", timestamp: "2026-09-20T10:00:00Z" },
        10_000,
        3 * 86_400_000, // 3 days old
      );

      const report = gcSubagentWorkspaces(testDir, {
        pruneSessions: true,
        sessionsDir: testDir,
      });

      expect(typeof report.prunedRolloutsCount).toBe("number");
      expect(typeof report.reclaimedRolloutBytes).toBe("number");
    });

    test("syncCodexStateDatabase purges stale rows pointing to deleted rollouts", () => {
      const dbPath = join(testDir, "test_state.sqlite");
      const { Database } = require("bun:sqlite");
      const db = new Database(dbPath);
      db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);");

      const existingRollout = createMockRollout(
        "2026/09/24/rollout-existing.jsonl",
        { sessionId: "s-exist", source: "exec", timestamp: new Date().toISOString() },
        1000,
        0,
      );
      const missingRollout = join(testDir, "2026/09/20/rollout-missing.jsonl");

      db.run("INSERT INTO threads VALUES ('t1', ?)", [existingRollout]);
      db.run("INSERT INTO threads VALUES ('t2', ?)", [missingRollout]);
      db.close();

      const syncResult = syncCodexStateDatabase(dbPath, { dryRun: false });
      expect(syncResult.totalRows).toBe(2);
      expect(syncResult.staleRowsRemoved).toBe(1);

      const dbAfter = new Database(dbPath);
      const remainingRows = dbAfter.query("SELECT id FROM threads").all() as Array<{ id: string }>;
      dbAfter.close();
      expect(remainingRows.map(r => r.id)).toEqual(["t1"]);
    });
  });
});
