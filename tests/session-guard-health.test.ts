import { describe, expect, test } from "bun:test";
import {
  SessionHealthGuard,
  SessionExpiredPreflightError,
  sessionHealthGuard,
} from "../src/adapters/chatgpt-web/session-guard";

describe("Sprint O: Proactive Session & Auth Guard (SessionHealthGuard)", () => {
  test("initial state is unknown with null metrics", () => {
    const guard = new SessionHealthGuard();
    const stats = guard.getStats();
    expect(stats.status).toBe("unknown");
    expect(stats.expires_at).toBeNull();
    expect(stats.seconds_remaining).toBeNull();
    expect(stats.warning_near_expiry).toBe(false);
    expect(stats.last_probe_ok).toBeNull();
    expect(stats.last_error).toBeNull();
  });

  test("records successful authentication with future expiry", () => {
    const guard = new SessionHealthGuard(300);
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour ahead
    guard.recordAuthenticationSuccess(futureExpiry);

    const stats = guard.getStats();
    expect(stats.status).toBe("authenticated");
    expect(stats.expires_at).toBe(futureExpiry);
    expect(stats.seconds_remaining).toBeGreaterThan(3000);
    expect(stats.warning_near_expiry).toBe(false);
    expect(stats.last_probe_ok).toBe(true);
    expect(stats.last_error).toBeNull();

    // Does not throw when healthy
    expect(() => guard.assertCanRunTurn()).not.toThrow();
  });

  test("transitions to warning_near_expiry when within threshold", () => {
    const guard = new SessionHealthGuard(300);
    const nearExpiry = Math.floor(Date.now() / 1000) + 120; // 2 minutes ahead (< 300s)
    guard.recordProbe(true, nearExpiry);

    const stats = guard.getStats();
    expect(stats.status).toBe("warning_near_expiry");
    expect(stats.warning_near_expiry).toBe(true);
    expect(stats.seconds_remaining).toBeLessThanOrEqual(120);

    // Can still run turn with warning
    expect(() => guard.assertCanRunTurn()).not.toThrow();
  });

  test("transitions to expired and throws SessionExpiredPreflightError when expiry passed", () => {
    const guard = new SessionHealthGuard(300);
    const pastExpiry = Math.floor(Date.now() / 1000) - 10; // 10s ago
    guard.recordProbe(true, pastExpiry);

    const stats = guard.getStats();
    expect(stats.status).toBe("expired");
    expect(stats.seconds_remaining).toBe(0);

    // Throws preflight error
    expect(() => guard.assertCanRunTurn()).toThrow(SessionExpiredPreflightError);
    try {
      guard.assertCanRunTurn();
    } catch (err) {
      expect((err as SessionExpiredPreflightError).status).toBe(401);
      expect((err as SessionExpiredPreflightError).code).toBe("session_expired_preflight");
      expect((err as SessionExpiredPreflightError).retryable).toBe(false);
    }
  });

  test("recordExplicitExpiry immediately sets expired status with custom error message", () => {
    const guard = new SessionHealthGuard();
    guard.recordExplicitExpiry("Your session has expired. Please log in again to continue.");

    const stats = guard.getStats();
    expect(stats.status).toBe("expired");
    expect(stats.last_probe_ok).toBe(false);
    expect(stats.last_error).toContain("Your session has expired");

    expect(() => guard.assertCanRunTurn()).toThrow("Your session has expired");
  });

  test("reset restores clean state", () => {
    const guard = new SessionHealthGuard();
    guard.recordExplicitExpiry("Session terminated");
    expect(guard.getStats().status).toBe("expired");

    guard.reset();
    expect(guard.getStats().status).toBe("unknown");
    expect(guard.getStats().last_error).toBeNull();
  });

  test("singleton instance is exported and operational", () => {
    expect(sessionHealthGuard).toBeInstanceOf(SessionHealthGuard);
  });
});
