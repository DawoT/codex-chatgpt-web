import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { startServer } from "../src/server";
import { runtimeMetrics } from "../src/adapters/chatgpt-web/runtime-metrics";
import { SlidingWindowRateLimiter } from "../src/adapters/chatgpt-web/rate-limiter";
import { CircuitBreaker } from "../src/adapters/chatgpt-web/circuit-breaker";

/**
 * Sprint AG: Rate Limiting & Circuit Breaker
 *
 * Verifies:
 * 1. SlidingWindowRateLimiter: allows requests within limit, rejects over limit
 * 2. SlidingWindowRateLimiter: retryAfterMs is set correctly on rejection
 * 3. SlidingWindowRateLimiter: window slides correctly (old requests expire)
 * 4. SlidingWindowRateLimiter: getTotalRejections accumulates
 * 5. SlidingWindowRateLimiter: disabled mode passes all requests
 * 6. CircuitBreaker: CLOSED → OPEN transition after errorThreshold errors
 * 7. CircuitBreaker: OPEN → HALF_OPEN transition after recoveryMs
 * 8. CircuitBreaker: HALF_OPEN → CLOSED on success, re-OPEN on error
 * 9. CircuitBreaker: totalOpens increments correctly
 * 10. runtimeMetrics: recordRateLimitRejection, recordCircuitBreakerOpen, recordUpstreamError
 * 11. GET /v1/responses rate limited → 429 with Retry-After header
 * 12. GET /metrics includes circuit_breaker_state and rate_limit_rejections_total
 */

describe("Sprint AG: Rate Limiting & Circuit Breaker", () => {
  beforeEach(() => {
    runtimeMetrics._resetForTest();
  });

  afterEach(() => {
    runtimeMetrics._resetForTest();
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tests 1–5: SlidingWindowRateLimiter
  // ────────────────────────────────────────────────────────────────────────────
  describe("SlidingWindowRateLimiter", () => {
    test("allows requests within limit", () => {
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 3, windowMs: 60_000 });
      const now = Date.now();

      const r1 = limiter.check("key1", now);
      expect(r1.allowed).toBe(true);
      expect(r1.count).toBe(1);

      const r2 = limiter.check("key1", now + 100);
      expect(r2.allowed).toBe(true);
      expect(r2.count).toBe(2);

      const r3 = limiter.check("key1", now + 200);
      expect(r3.allowed).toBe(true);
      expect(r3.count).toBe(3);
    });

    test("rejects requests that exceed the per-window limit", () => {
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 2, windowMs: 60_000 });
      const now = Date.now();

      limiter.check("key1", now);
      limiter.check("key1", now + 100);

      // 3rd request exceeds limit
      const r = limiter.check("key1", now + 200);
      expect(r.allowed).toBe(false);
      expect(r.count).toBe(2); // count = requests still in window
      expect(r.limit).toBe(2);
      expect(r.retryAfterMs).toBeGreaterThan(0);
    });

    test("retryAfterMs is time until oldest request exits the window", () => {
      const windowMs = 10_000;
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 1, windowMs });
      const now = 1_000_000;

      limiter.check("key1", now);

      const r = limiter.check("key1", now + 2_000);
      expect(r.allowed).toBe(false);
      // oldest = now (1_000_000), window = 10_000, retryAfter = now + windowMs - (now + 2000) = 8000
      expect(r.retryAfterMs).toBeCloseTo(8_000, -2);
    });

    test("sliding window: old requests expire and new ones are allowed again", () => {
      const windowMs = 5_000;
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 2, windowMs });
      const now = 1_000_000;

      limiter.check("key1", now);
      limiter.check("key1", now + 1_000);

      // At now+2000, still blocked
      expect(limiter.check("key1", now + 2_000).allowed).toBe(false);

      // At now+5001, the first request (at `now`) has expired (cutoff = now+1), the second (now+1000) survives
      // So 1 surviving + this new one = count 2, still under limit of 2 → allowed
      const r = limiter.check("key1", now + 5_001);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(2); // 1 surviving from window + 1 new
    });

    test("different keys are tracked independently", () => {
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 1, windowMs: 60_000 });
      const now = Date.now();

      expect(limiter.check("alice", now).allowed).toBe(true);
      expect(limiter.check("bob", now).allowed).toBe(true);
      // alice now at limit, bob is also at limit
      expect(limiter.check("alice", now + 1).allowed).toBe(false);
      expect(limiter.check("bob", now + 1).allowed).toBe(false);
    });

    test("getTotalRejections accumulates across all keys", () => {
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 1, windowMs: 60_000 });
      const now = Date.now();

      limiter.check("k1", now);
      limiter.check("k1", now + 1); // rejected
      limiter.check("k2", now);
      limiter.check("k2", now + 1); // rejected

      expect(limiter.getTotalRejections()).toBe(2);
    });

    test("disabled mode passes all requests regardless of count", () => {
      const limiter = new SlidingWindowRateLimiter({ limitPerWindow: 1, windowMs: 60_000, disabled: true });
      const now = Date.now();

      for (let i = 0; i < 100; i++) {
        expect(limiter.check("key1", now + i).allowed).toBe(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Tests 6–9: CircuitBreaker
  // ────────────────────────────────────────────────────────────────────────────
  describe("CircuitBreaker", () => {
    test("starts CLOSED and allows all requests", () => {
      const cb = new CircuitBreaker({ errorThreshold: 3, recoveryMs: 5_000 });
      expect(cb.getState()).toBe("CLOSED");
      expect(cb.isAllowed()).toBe(true);
    });

    test("CLOSED → OPEN after errorThreshold consecutive errors", () => {
      const cb = new CircuitBreaker({ errorThreshold: 3, recoveryMs: 5_000 });
      const now = Date.now();

      cb.recordError(now);
      expect(cb.getState()).toBe("CLOSED");

      cb.recordError(now + 100);
      expect(cb.getState()).toBe("CLOSED");

      cb.recordError(now + 200); // 3rd error → opens
      expect(cb.getState()).toBe("OPEN");
      expect(cb.isAllowed(now + 200)).toBe(false);
    });

    test("OPEN → HALF_OPEN after recoveryMs, and allows one probe", () => {
      const cb = new CircuitBreaker({ errorThreshold: 2, recoveryMs: 10_000 });
      const t0 = 1_000_000;

      cb.recordError(t0);
      cb.recordError(t0 + 1);
      expect(cb.getState()).toBe("OPEN");

      // Still OPEN before recovery window
      expect(cb.isAllowed(t0 + 9_999)).toBe(false);

      // Probe allowed after recovery window
      expect(cb.isAllowed(t0 + 10_001)).toBe(true);
      expect(cb.getState()).toBe("HALF_OPEN");
    });

    test("HALF_OPEN → CLOSED on success, resets error count", () => {
      const cb = new CircuitBreaker({ errorThreshold: 2, recoveryMs: 10_000 });
      const t0 = 1_000_000;

      cb.recordError(t0);
      cb.recordError(t0 + 1);
      cb.isAllowed(t0 + 10_001); // → HALF_OPEN

      cb.recordSuccess();
      expect(cb.getState()).toBe("CLOSED");
      expect(cb.isAllowed()).toBe(true);
    });

    test("HALF_OPEN → OPEN on error (re-opens)", () => {
      const cb = new CircuitBreaker({ errorThreshold: 2, recoveryMs: 10_000 });
      const t0 = 1_000_000;

      cb.recordError(t0);
      cb.recordError(t0 + 1);
      cb.isAllowed(t0 + 10_001); // → HALF_OPEN

      cb.recordError(t0 + 10_002); // probe fails → re-opens
      expect(cb.getState()).toBe("OPEN");
    });

    test("totalOpens increments each time circuit opens", () => {
      const cb = new CircuitBreaker({ errorThreshold: 2, recoveryMs: 10_000 });
      const t0 = 1_000_000;

      cb.recordError(t0);
      cb.recordError(t0 + 1);
      expect(cb.getTotalOpens()).toBe(1);

      // Recover and trip again
      cb.isAllowed(t0 + 10_001); // HALF_OPEN
      cb.recordSuccess(); // CLOSED
      cb.recordError(t0 + 20_000);
      cb.recordError(t0 + 20_001);
      expect(cb.getTotalOpens()).toBe(2);
    });

    test("getStateNumeric returns 0/1/2 for closed/open/half-open", () => {
      const cb = new CircuitBreaker({ errorThreshold: 2, recoveryMs: 10_000 });
      const t0 = 1_000_000;

      expect(cb.getStateNumeric()).toBe(0); // CLOSED

      cb.recordError(t0);
      cb.recordError(t0 + 1);
      expect(cb.getStateNumeric()).toBe(1); // OPEN

      cb.isAllowed(t0 + 10_001);
      expect(cb.getStateNumeric()).toBe(2); // HALF_OPEN
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 10: runtimeMetrics Sprint AG counters
  // ────────────────────────────────────────────────────────────────────────────
  describe("runtimeMetrics Sprint AG counters", () => {
    test("recordRateLimitRejection, recordCircuitBreakerOpen, recordUpstreamError accumulate", () => {
      runtimeMetrics.recordRateLimitRejection();
      runtimeMetrics.recordRateLimitRejection();
      runtimeMetrics.recordCircuitBreakerOpen();
      runtimeMetrics.recordUpstreamError();
      runtimeMetrics.recordUpstreamError();
      runtimeMetrics.recordUpstreamError();

      const snap = runtimeMetrics.getSnapshot();
      expect(snap.rate_limit_rejections).toBe(2);
      expect(snap.circuit_breaker_opens).toBe(1);
      expect(snap.circuit_breaker_state).toBe(1); // recordCircuitBreakerOpen sets state=1
      expect(snap.upstream_errors).toBe(3);
    });

    test("setCircuitBreakerState updates gauge without incrementing opens", () => {
      runtimeMetrics.setCircuitBreakerState(2); // half-open
      const snap = runtimeMetrics.getSnapshot();
      expect(snap.circuit_breaker_state).toBe(2);
      expect(snap.circuit_breaker_opens).toBe(0);
    });

    test("Sprint AG metrics appear in Prometheus output", () => {
      runtimeMetrics.recordRateLimitRejection();
      runtimeMetrics.recordCircuitBreakerOpen();

      const text = runtimeMetrics.serializePrometheusMetrics();
      expect(text).toContain("codex_chatgpt_web_rate_limit_rejections_total 1");
      expect(text).toContain("codex_chatgpt_web_circuit_breaker_opens_total 1");
      expect(text).toContain("# TYPE codex_chatgpt_web_circuit_breaker_state gauge");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 11: Live /v1/responses rate limiting (429)
  // ────────────────────────────────────────────────────────────────────────────
  describe("Live server rate limiting", () => {
    test("POST /v1/responses exceeding rate limit returns 429 with Retry-After", async () => {
      const config = defaultConfig("browser-only");
      config.port = 0;
      config.host = "127.0.0.1";
      // Set very tight rate limit: 2 req/min for testing
      config.rateLimitRpm = 2;
      const server = startServer(config);
      try {
        const makeRequest = () => fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer test-api-key-for-rate-limit-test`,
          },
          body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
        });

        // First 2 requests may pass or fail for upstream reasons (draining/no session),
        // but the 3rd must be rate-limited → 429
        await makeRequest(); // 1st
        await makeRequest(); // 2nd
        const r3 = await makeRequest(); // 3rd — should be 429

        expect(r3.status).toBe(429);
        const retryAfter = r3.headers.get("retry-after");
        expect(retryAfter).toBeTruthy();
      } finally {
        server.stop(true);
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Test 12: GET /metrics includes Sprint AG metrics
  // ────────────────────────────────────────────────────────────────────────────
  describe("GET /metrics includes Sprint AG counters", () => {
    test("/metrics includes circuit_breaker_state gauge and rate_limit_rejections counter", async () => {
      const config = defaultConfig("browser-only");
      config.port = 0;
      config.host = "127.0.0.1";
      const server = startServer(config);
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("codex_chatgpt_web_circuit_breaker_state");
        expect(body).toContain("codex_chatgpt_web_rate_limit_rejections_total");
        expect(body).toContain("codex_chatgpt_web_upstream_errors_total");
      } finally {
        server.stop(true);
      }
    });
  });
});
