import { describe, expect, test } from "bun:test";
import { SessionHealthGuard } from "../src/adapters/chatgpt-web/session-guard";

describe("Sprint T: Autonomous Health Watchdog & Background Cookie Refresher", () => {
  test("startWatchdog starts the periodic timer and reflects in getStats()", () => {
    const guard = new SessionHealthGuard();
    expect(guard.isWatchdogActive()).toBe(false);
    expect(guard.getStats().watchdog_active).toBe(false);

    guard.startWatchdog(10_000);
    expect(guard.isWatchdogActive()).toBe(true);
    expect(guard.getStats().watchdog_active).toBe(true);

    guard.stopWatchdog();
    expect(guard.isWatchdogActive()).toBe(false);
    expect(guard.getStats().watchdog_active).toBe(false);
  });

  test("watchdog periodically polls probeFn and updates session stats", async () => {
    const guard = new SessionHealthGuard(300);
    let probeCalls = 0;
    const futureExpiry = Math.floor(Date.now() / 1000) + 1800;

    guard.startWatchdog(20, async () => {
      probeCalls += 1;
      return { success: true, expiresAt: futureExpiry };
    });

    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(probeCalls).toBeGreaterThanOrEqual(1);
    const stats = guard.getStats();
    expect(stats.status).toBe("authenticated");
    expect(stats.expires_at).toBe(futureExpiry);
    expect(stats.last_probe_ok).toBe(true);
  });

  test("watchdog triggers refreshFn when session is near expiry and restores authenticated status", async () => {
    const guard = new SessionHealthGuard(300);
    // Set near expiry (< 300s)
    const nearExpiry = Math.floor(Date.now() / 1000) + 60;
    guard.recordProbe(true, nearExpiry);
    expect(guard.getStats().warning_near_expiry).toBe(true);

    let refreshCalled = 0;
    const refreshedExpiry = Math.floor(Date.now() / 1000) + 3600;

    guard.startWatchdog(
      20,
      async () => ({ success: true, expiresAt: nearExpiry }),
      async () => {
        refreshCalled += 1;
        guard.recordAuthenticationSuccess(refreshedExpiry);
        return true;
      },
    );

    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(refreshCalled).toBeGreaterThanOrEqual(1);
    const stats = guard.getStats();
    expect(stats.status).toBe("authenticated");
    expect(stats.warning_near_expiry).toBe(false);
    expect(stats.refresh_success_count).toBeGreaterThanOrEqual(1);
  });

  test("watchdog tracks refresh failures gracefully without throwing", async () => {
    const guard = new SessionHealthGuard(300);
    guard.recordProbe(true, Math.floor(Date.now() / 1000) + 50); // near expiry

    let refreshAttempts = 0;
    guard.startWatchdog(
      20,
      undefined,
      async () => {
        refreshAttempts += 1;
        return false; // failure
      },
    );

    await Bun.sleep(60);
    guard.stopWatchdog();

    expect(refreshAttempts).toBeGreaterThanOrEqual(1);
    const stats = guard.getStats();
    expect(stats.refresh_failure_count).toBeGreaterThanOrEqual(1);
  });

  test("reset() stops active watchdog and clears metrics", () => {
    const guard = new SessionHealthGuard();
    guard.startWatchdog(10_000);
    guard.recordAuthenticationSuccess(Math.floor(Date.now() / 1000) + 500);

    expect(guard.isWatchdogActive()).toBe(true);
    guard.reset();

    expect(guard.isWatchdogActive()).toBe(false);
    const stats = guard.getStats();
    expect(stats.status).toBe("unknown");
    expect(stats.watchdog_active).toBe(false);
    expect(stats.refresh_success_count).toBe(0);
    expect(stats.refresh_failure_count).toBe(0);
  });
});
