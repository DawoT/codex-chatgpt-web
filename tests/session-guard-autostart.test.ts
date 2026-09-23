import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { SessionHealthGuard, sessionHealthGuard } from "../src/adapters/chatgpt-web/session-guard";
import { defaultConfig, defaultBrokerEndpoint } from "../src/config";
import { startServer } from "../src/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Sprint W: Background Session Proactive Refresher & Watchdog Auto-Start", () => {
  beforeEach(() => {
    sessionHealthGuard.reset();
  });

  afterEach(() => {
    sessionHealthGuard.reset();
  });

  test("watchdog periodically probes and updates session health status", async () => {
    const guard = new SessionHealthGuard({ warningThresholdSeconds: 300 });
    let probeCalled = 0;

    guard.startWatchdog(20, async () => {
      probeCalled += 1;
      return { success: true, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    });

    expect(guard.isWatchdogActive()).toBe(true);

    // Wait for at least 2 ticks
    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(guard.isWatchdogActive()).toBe(false);
    expect(probeCalled).toBeGreaterThanOrEqual(1);

    const stats = guard.getStats();
    expect(stats.status).toBe("authenticated");
    expect(stats.last_probe_ok).toBe(true);
    expect(stats.last_probe_at).not.toBeNull();
  });

  test("watchdog triggers refresh when near expiry and handles success", async () => {
    const guard = new SessionHealthGuard({ warningThresholdSeconds: 300 });
    let refreshCalls = 0;

    // Seed near expiry (100s remaining <= 300s)
    guard.recordProbe(true, Math.floor(Date.now() / 1000) + 100);
    expect(guard.getStats().status).toBe("warning_near_expiry");

    guard.startWatchdog(
      20,
      undefined,
      async () => {
        refreshCalls += 1;
        // Simulates refresh extending token
        guard.recordAuthenticationSuccess(Math.floor(Date.now() / 1000) + 7200);
        return true;
      },
    );

    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    const stats = guard.getStats();
    expect(stats.refresh_success_count).toBeGreaterThanOrEqual(1);
    expect(stats.status).toBe("authenticated");
  });

  test("watchdog tracks refresh failures without throwing", async () => {
    const guard = new SessionHealthGuard({ warningThresholdSeconds: 300 });
    let refreshCalls = 0;

    // Seed expired
    guard.recordProbe(true, Math.floor(Date.now() / 1000) - 10);
    expect(guard.getStats().status).toBe("expired");

    guard.startWatchdog(
      20,
      undefined,
      async () => {
        refreshCalls += 1;
        throw new Error("Network timeout during proactive session refresh");
      },
    );

    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(refreshCalls).toBeGreaterThanOrEqual(1);
    const stats = guard.getStats();
    expect(stats.refresh_failure_count).toBeGreaterThanOrEqual(1);
  });

  test("watchdog prevents concurrent refreshes when refresh takes longer than tick interval", async () => {
    const guard = new SessionHealthGuard({ warningThresholdSeconds: 300 });
    guard.recordProbe(true, Math.floor(Date.now() / 1000) + 50);

    let concurrentCount = 0;
    let maxConcurrent = 0;
    let totalRefreshes = 0;

    guard.startWatchdog(
      10,
      undefined,
      async () => {
        concurrentCount += 1;
        totalRefreshes += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await Bun.sleep(40);
        concurrentCount -= 1;
        return true;
      },
    );

    await Bun.sleep(90);
    guard.stopWatchdog();

    expect(maxConcurrent).toBe(1);
    expect(totalRefreshes).toBeGreaterThanOrEqual(1);
  });

  test("server auto-starts session watchdog in full mode and stops on shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-session-watchdog-"));
    try {
      const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
      expect(sessionHealthGuard.isWatchdogActive()).toBe(false);

      const server = startServer(config);
      try {
        expect(sessionHealthGuard.isWatchdogActive()).toBe(true);

        const endpoint = `http://127.0.0.1:${server.port}`;
        const authorization = { authorization: `Bearer ${config.controlToken}` };

        // Drain first then shutdown
        const drain = await fetch(`${endpoint}/admin/drain`, {
          method: "POST",
          headers: authorization,
        });
        expect(drain.status).toBe(200);

        const shutdown = await fetch(`${endpoint}/admin/shutdown`, {
          method: "POST",
          headers: authorization,
        });
        expect(shutdown.status).toBe(200);

        // Allow asynchronous shutdown to execute
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && sessionHealthGuard.isWatchdogActive()) {
          await Bun.sleep(20);
        }
        expect(sessionHealthGuard.isWatchdogActive()).toBe(false);
      } finally {
        server.stop(true);
      }
    } finally {
      sessionHealthGuard.reset();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("server does not auto-start watchdog in browser-only mode", async () => {
    const config = { ...defaultConfig("browser-only"), port: 0 };
    expect(sessionHealthGuard.isWatchdogActive()).toBe(false);

    const server = startServer(config);
    try {
      expect(sessionHealthGuard.isWatchdogActive()).toBe(false);
    } finally {
      server.stop(true);
      sessionHealthGuard.reset();
    }
  });
});
