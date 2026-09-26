import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { runtimeMetrics } from "../src/adapters/chatgpt-web/runtime-metrics";
import type { RuntimeMetricsSnapshot, StructuredLogEntry, RuntimeAlert } from "../src/adapters/chatgpt-web/runtime-metrics";

/**
 * Sprint AE: Observability Dashboard & Runtime Metrics Endpoint
 *
 * Verifies:
 * 1. Counter semantics: turn, spooler, janitor, compaction counters increment correctly
 * 2. Gauge behavior: setActiveTurns mirrors live count
 * 3. Prometheus text format: structure, naming convention, counter/gauge type declarations
 * 4. Admin status snapshot: unified JSON with alerts and section keys
 * 5. Alerting hooks: janitor consecutive errors trigger warnings/critical after threshold
 * 6. Structured error logging: entries captured, rolling window, recent retrieval
 * 7. /metrics HTTP endpoint: returns Prometheus text with correct Content-Type
 * 8. /admin/status HTTP endpoint: returns JSON snapshot with all required sections
 * 9. /healthz includes alerts array when janitor has consecutive errors
 * 10. Metrics reset isolation between tests
 */

describe("Sprint AE: Observability Dashboard & Runtime Metrics Endpoint", () => {
  let metrics: typeof runtimeMetrics;

  beforeEach(() => {
    metrics = runtimeMetrics;
    metrics._resetForTest();
  });

  afterEach(() => {
    metrics._resetForTest();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 1: Counter semantics
  // ────────────────────────────────────────────────────────────────────────────
  describe("Counter semantics", () => {
    test("turn counters increment correctly across lifecycle events", () => {
      expect(metrics.getSnapshot().turns_total).toBe(0);
      expect(metrics.getSnapshot().turns_active).toBe(0);

      metrics.recordTurnStart();
      metrics.recordTurnStart();
      let snap = metrics.getSnapshot();
      expect(snap.turns_total).toBe(2);
      expect(snap.turns_active).toBe(2);

      metrics.recordTurnSuccess();
      snap = metrics.getSnapshot();
      expect(snap.turns_success).toBe(1);
      expect(snap.turns_active).toBe(1);

      metrics.recordTurnError();
      snap = metrics.getSnapshot();
      expect(snap.turns_error).toBe(1);
      expect(snap.turns_active).toBe(0);

      // Totals: 2 started, 1 success, 1 error
      expect(snap.turns_total).toBe(2);
    });

    test("spooler counters track write bytes and GC bytes independently", () => {
      metrics.recordSpoolerWrite(1024);
      metrics.recordSpoolerWrite(4096);
      metrics.recordSpoolerGc(2048);

      const snap = metrics.getSnapshot();
      expect(snap.spooler_bytes_written).toBe(5120);
      expect(snap.spooler_files_written).toBe(2);
      expect(snap.spooler_bytes_freed).toBe(2048);
    });

    test("janitor counters track pruning across multiple runs", () => {
      metrics.recordJanitorRun({ filesPruned: 10, bytesReclaimed: 1_000_000, error: false });
      metrics.recordJanitorRun({ filesPruned: 5, bytesReclaimed: 500_000, error: false });

      const snap = metrics.getSnapshot();
      expect(snap.janitor_runs_total).toBe(2);
      expect(snap.janitor_files_pruned).toBe(15);
      expect(snap.janitor_bytes_reclaimed).toBe(1_500_000);
      expect(snap.janitor_runs_error).toBe(0);
      expect(snap.janitor_consecutive_errors).toBe(0);
    });

    test("compaction and checkpoint counters are independent", () => {
      metrics.recordCheckpointWritten();
      metrics.recordCheckpointWritten();
      metrics.recordCheckpointWritten();
      metrics.recordCompaction();

      const snap = metrics.getSnapshot();
      expect(snap.checkpoints_written).toBe(3);
      expect(snap.compactions_total).toBe(1);
    });

    test("setActiveTurns overrides gauge directly without affecting monotonic counters", () => {
      metrics.recordTurnStart();
      metrics.recordTurnStart();
      expect(metrics.getSnapshot().turns_active).toBe(2);

      // External override (e.g. from live httpTurns.count())
      metrics.setActiveTurns(0);
      const snap = metrics.getSnapshot();
      expect(snap.turns_active).toBe(0);
      // Monotonic counters unchanged
      expect(snap.turns_total).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 2: Alerting hooks
  // ────────────────────────────────────────────────────────────────────────────
  describe("Alerting hooks", () => {
    test("no alerts when janitor consecutive_errors is below threshold", () => {
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      const alerts = metrics.getAlerts();
      expect(alerts).toHaveLength(0);
      expect(metrics.getSnapshot().janitor_consecutive_errors).toBe(1);
    });

    test("warning alert fires at consecutive_errors >= 2 (JANITOR_ALERT_THRESHOLD)", () => {
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });

      const alerts = metrics.getAlerts();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.alert_id).toBe("janitor_consecutive_errors");
      expect(alerts[0]!.severity).toBe("warning");
    });

    test("critical alert fires at consecutive_errors >= 5", () => {
      for (let i = 0; i < 5; i++) {
        metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      }
      const alerts = metrics.getAlerts();
      expect(alerts[0]!.severity).toBe("critical");
      expect(metrics.getSnapshot().janitor_consecutive_errors).toBe(5);
    });

    test("consecutive_errors resets to 0 after a successful janitor run", () => {
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      expect(metrics.getAlerts()).toHaveLength(1);

      // Successful run resets the streak
      metrics.recordJanitorRun({ filesPruned: 5, bytesReclaimed: 100_000, error: false });
      expect(metrics.getAlerts()).toHaveLength(0);
      expect(metrics.getSnapshot().janitor_consecutive_errors).toBe(0);
      // Total error count still includes the 2 previous errors
      expect(metrics.getSnapshot().janitor_runs_error).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 3: Structured error logging
  // ────────────────────────────────────────────────────────────────────────────
  describe("Structured error logging", () => {
    test("logStructuredError captures entry with all required fields and increments counter", () => {
      metrics.logStructuredError({
        error_code: "SPOOLER_WRITE_FAILED",
        severity: "high",
        context: "spoolToolOutput",
        message: "Failed to write spool file: ENOSPC",
        stack_digest: "abc123",
      });

      const snap = metrics.getSnapshot();
      expect(snap.structured_errors_total).toBe(1);

      const recent = metrics.getRecentErrors(5);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.error_code).toBe("SPOOLER_WRITE_FAILED");
      expect(recent[0]!.severity).toBe("high");
      expect(recent[0]!.recorded_at).toBeTruthy();
    });

    test("getRecentErrors returns entries latest first up to limit n", () => {
      for (let i = 0; i < 5; i++) {
        metrics.logStructuredError({
          error_code: `ERR_${i}`,
          severity: "low",
          context: "test",
          message: `error ${i}`,
        });
      }

      const recent = metrics.getRecentErrors(3);
      expect(recent).toHaveLength(3);
      // Latest entry first
      expect(recent[0]!.error_code).toBe("ERR_4");
      expect(recent[1]!.error_code).toBe("ERR_3");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 4: Prometheus text format
  // ────────────────────────────────────────────────────────────────────────────
  describe("Prometheus text format", () => {
    test("serializePrometheusMetrics produces valid Prometheus text with correct types", () => {
      metrics.recordTurnStart();
      metrics.recordTurnSuccess();
      metrics.recordSpoolerWrite(8192);
      metrics.recordJanitorRun({ filesPruned: 3, bytesReclaimed: 30_000, error: false });
      metrics.recordCheckpointWritten();

      const text = metrics.serializePrometheusMetrics();

      // Must end with newline
      expect(text.endsWith("\n")).toBe(true);

      // Check counter declarations
      expect(text).toContain("# TYPE codex_chatgpt_web_turns counter");
      expect(text).toContain("codex_chatgpt_web_turns_total 1");

      // Check gauge declarations
      expect(text).toContain("# TYPE codex_chatgpt_web_turns_active gauge");
      expect(text).toContain("codex_chatgpt_web_turns_active 0");

      // Spooler
      expect(text).toContain("codex_chatgpt_web_spooler_bytes_written_total 8192");
      expect(text).toContain("codex_chatgpt_web_spooler_files_written_total 1");

      // Janitor
      expect(text).toContain("codex_chatgpt_web_janitor_files_pruned_total 3");
      expect(text).toContain("codex_chatgpt_web_janitor_bytes_reclaimed_total 30000");
    });

    test("custom prefix applies to all metric names", () => {
      const text = metrics.serializePrometheusMetrics("myapp");
      expect(text).toContain("myapp_turns_total");
      expect(text).not.toContain("codex_chatgpt_web_turns_total");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 5: Admin status snapshot
  // ────────────────────────────────────────────────────────────────────────────
  describe("buildAdminStatus", () => {
    test("returns ok status with all required sections when no alerts", () => {
      metrics.recordTurnStart();
      metrics.recordTurnSuccess();

      const status = metrics.buildAdminStatus({
        daemonPid: 12345,
        version: "6.0.0",
        mode: "full",
        uptimeMs: 60_000,
        janitorStats: { enabled: true, running: true, runs_count: 1 },
        sessionCount: 356,
        sessionBytes: 2_000_000_000,
      });

      expect(status["status"]).toBe("ok");
      expect((status["daemon"] as Record<string, unknown>)["pid"]).toBe(12345);
      expect((status["daemon"] as Record<string, unknown>)["mode"]).toBe("full");
      expect((status["daemon"] as Record<string, unknown>)["uptime_seconds"]).toBe(60);
      expect(status["alerts"]).toHaveLength(0);
      expect((status["metrics"] as RuntimeMetricsSnapshot)["turns_total"]).toBe(1);
      expect((status["session_store"] as Record<string, unknown>)["files"]).toBe(356);
      expect(status["janitor"]).toBeTruthy();
      expect(status["recent_errors"]).toBeDefined();
    });

    test("returns warning status when janitor has consecutive errors >= threshold", () => {
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });
      metrics.recordJanitorRun({ filesPruned: 0, bytesReclaimed: 0, error: true });

      const status = metrics.buildAdminStatus({
        daemonPid: 1,
        version: "6.0.0",
        mode: "full",
        uptimeMs: 1000,
      });

      expect(status["status"]).toBe("warning");
      expect((status["alerts"] as RuntimeAlert[]).length).toBeGreaterThanOrEqual(1);
      expect((status["alerts"] as RuntimeAlert[])[0]!.alert_id).toBe("janitor_consecutive_errors");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 6: GET /metrics HTTP endpoint
  // ────────────────────────────────────────────────────────────────────────────
  describe("GET /metrics HTTP endpoint", () => {
    test("returns 200 with text/plain; version=0.0.4 Content-Type and Prometheus body", async () => {
      const config = defaultConfig("browser-only");
      config.port = 17883;
      config.host = "127.0.0.1";
      const server = startServer(config);
      try {
        const url = `http://${config.host}:${config.port}/metrics`;
        const res = await fetch(url);
        expect(res.status).toBe(200);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).toContain("text/plain");
        const body = await res.text();
        expect(body).toContain("# TYPE");
        expect(body).toContain("codex_chatgpt_web_");
        expect(body.endsWith("\n")).toBe(true);
      } finally {
        await server.stop(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 7: GET /admin/status HTTP endpoint
  // ────────────────────────────────────────────────────────────────────────────
  describe("GET /admin/status HTTP endpoint", () => {
    test("returns 401 without auth and 200 JSON with daemon/metrics/alerts on auth", async () => {
      const config = defaultConfig("browser-only");
      config.port = 17884;
      config.host = "127.0.0.1";
      const server = startServer(config);
      try {
        const baseUrl = `http://${config.host}:${config.port}/admin/status`;

        // Unauthenticated
        const unauth = await fetch(baseUrl);
        expect(unauth.status).toBe(401);

        // Authenticated
        const auth = await fetch(baseUrl, {
          headers: { authorization: `Bearer ${config.controlToken}` },
        });
        expect(auth.status).toBe(200);
        const body = await auth.json() as Record<string, unknown>;
        expect(body["status"]).toMatch(/^(ok|warning|degraded)$/);
        expect(body["daemon"]).toBeDefined();
        expect(body["metrics"]).toBeDefined();
        expect(body["alerts"]).toBeDefined();
        expect(body["session_store"]).toBeDefined();
        expect(body["recent_errors"]).toBeDefined();
      } finally {
        await server.stop(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 8: /healthz alerts section
  // ────────────────────────────────────────────────────────────────────────────
  describe("/healthz alerts integration", () => {
    test("GET /healthz includes alerts array (empty when all systems nominal)", async () => {
      const config = defaultConfig("browser-only");
      config.port = 17885;
      config.host = "127.0.0.1";
      const server = startServer(config);
      try {
        const res = await fetch(`http://${config.host}:${config.port}/healthz`);
        expect(res.status).toBe(200);
        const body = await res.json() as Record<string, unknown>;
        // alerts should be present (empty array when nominal)
        expect(Array.isArray(body["alerts"])).toBe(true);
        expect(body["alerts"]).toHaveLength(0);
      } finally {
        await server.stop(true);
      }
    });
  });
});
