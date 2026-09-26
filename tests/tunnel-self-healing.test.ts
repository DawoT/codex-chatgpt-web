import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, TunnelConfig } from "../src/config";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { TunnelSupervisor, defaultHealthUrlProbe } from "../src/tunnel-supervisor";
import type { TunnelRuntimeStatus } from "../src/tunnel";
import { startServer } from "../src/server";

function createMockTunnelConfig(): TunnelConfig {
  return {
    binaryPath: "/path/to/mock/tunnel-client",
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKeyFile: "/path/to/mock/key.key",
    profileDir: "/path/to/mock/profiles",
    profileName: "codex-chatgpt-web",
    alias: "codex-chatgpt-web",
  };
}

function createMockAppConfig(mode: "full" | "browser-only" = "full"): AppConfig {
  const base = defaultConfig(mode);
  const root = mkdtempSync(join(tmpdir(), "cgw-mock-tunnel-"));
  return {
    ...base,
    port: 0,
    brokerSocketPath: defaultBrokerEndpoint(root),
    controlToken: "test-control-token",
    tunnel: mode === "full" ? createMockTunnelConfig() : undefined,
  };
}

describe("Sprint I: Tunnel Supervisor & Self-Healing", () => {
  test("remains disabled and does not start when mode is browser-only or tunnel is missing", async () => {
    const config = createMockAppConfig("browser-only");
    const supervisor = new TunnelSupervisor({ config });

    const stats = supervisor.getStats();
    expect(stats.enabled).toBe(false);
    expect(stats.status).toBe("disabled");
    expect(stats.auto_restarts).toBe(0);

    supervisor.start();
    expect(supervisor.getStats().status).toBe("disabled");

    const probe = await supervisor.probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("disabled");

    supervisor.stop();
  });

  test("initializes enabled in full mode with tunnel config", () => {
    const config = createMockAppConfig("full");
    const supervisor = new TunnelSupervisor({ config });

    const stats = supervisor.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.status).toBe("idle");
    expect(stats.auto_restarts).toBe(0);
    expect(stats.last_auto_restart_at).toBeNull();
    expect(stats.consecutive_failures).toBe(0);
  });

  test("HTTP fast path probe returns healthy without calling statusProbe", async () => {
    const config = createMockAppConfig("full");
    let statusProbeCalled = false;

    const supervisor = new TunnelSupervisor({
      config,
      healthUrlProbe: async () => true, // mock fast-path HTTP /readyz ok
      statusProbe: () => {
        statusProbeCalled = true;
        return { ok: true, processRunning: true, healthy: true, ready: true, detail: "mock" };
      },
    });

    const result = await supervisor.probe();
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.detail).toBe("http readyz ok");
    expect(statusProbeCalled).toBe(false);

    const stats = supervisor.getStats();
    expect(stats.last_probe_ok).toBe(true);
    expect(stats.last_probe_at).toBeString();
  });

  test("falls back to statusProbe when HTTP probe is unavailable or returns false", async () => {
    const config = createMockAppConfig("full");
    let statusProbeCalled = false;

    const supervisor = new TunnelSupervisor({
      config,
      healthUrlProbe: async () => false, // HTTP failed
      statusProbe: () => {
        statusProbeCalled = true;
        return {
          ok: true,
          processRunning: true,
          healthy: true,
          ready: true,
          detail: "process_running=true healthy=true ready=true",
        };
      },
    });

    const result = await supervisor.probe();
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(statusProbeCalled).toBe(true);
    expect(result.detail).toContain("process_running=true");
  });

  test("auto-recovery recovers an unhealthy tunnel on first attempt and updates stats", async () => {
    const config = createMockAppConfig("full");
    let isHealthy = false;
    let restartActionCalls = 0;

    const supervisor = new TunnelSupervisor({
      config,
      pollIntervalMs: 50,
      backoffDelaysMs: [5, 10, 20],
      healthUrlProbe: async () => isHealthy,
      statusProbe: () => ({
        ok: isHealthy,
        processRunning: isHealthy,
        healthy: isHealthy,
        ready: isHealthy,
        detail: isHealthy ? "ready" : "process_running=false",
      }),
      restartAction: async () => {
        restartActionCalls += 1;
        isHealthy = true; // Recovered!
      },
    });

    // Probe should detect down and recover
    const recovered = await supervisor.probeAndRecover();
    expect(recovered).toBe(true);
    expect(restartActionCalls).toBe(1);

    const stats = supervisor.getStats();
    expect(stats.auto_restarts).toBe(1);
    expect(stats.last_auto_restart_at).toBeString();
    expect(stats.consecutive_failures).toBe(0);
    expect(stats.status).toBe("running");
  });

  test("auto-recovery retries with backoff and transitions to degraded if retries exhaust", async () => {
    const config = createMockAppConfig("full");
    let restartAttempts = 0;

    const supervisor = new TunnelSupervisor({
      config,
      maxConsecutiveRestarts: 3,
      backoffDelaysMs: [2, 5, 10],
      healthUrlProbe: async () => false,
      statusProbe: () => ({
        ok: false,
        processRunning: false,
        healthy: false,
        ready: false,
        detail: "process_running=false",
      }),
      restartAction: async () => {
        restartAttempts += 1;
        throw new Error(`Connection to OpenAI control plane refused (attempt ${restartAttempts})`);
      },
    });

    const recovered = await supervisor.probeAndRecover();
    expect(recovered).toBe(false);
    expect(restartAttempts).toBe(3);

    const stats = supervisor.getStats();
    expect(stats.auto_restarts).toBe(0);
    expect(stats.consecutive_failures).toBe(1);
    expect(stats.status).toBe("degraded");
    expect(stats.last_error).toContain("Connection to OpenAI control plane refused");
  });

  test("concurrent recovery calls are deduplicated via mutex", async () => {
    const config = createMockAppConfig("full");
    let isHealthy = false;
    let restartCount = 0;

    const supervisor = new TunnelSupervisor({
      config,
      backoffDelaysMs: [10],
      healthUrlProbe: async () => isHealthy,
      statusProbe: () => ({
        ok: isHealthy,
        processRunning: isHealthy,
        healthy: isHealthy,
        ready: isHealthy,
        detail: isHealthy ? "ready" : "stopped",
      }),
      restartAction: async () => {
        restartCount += 1;
        await Bun.sleep(25);
        isHealthy = true;
      },
    });

    // Fire 3 simultaneous recover calls
    const [r1, r2, r3] = await Promise.all([
      supervisor.recover(),
      supervisor.recover(),
      supervisor.recover(),
    ]);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(restartCount).toBe(1); // Exactly one restart occurred
    expect(supervisor.getStats().auto_restarts).toBe(1);
  });

  test("start and stop manage periodic polling timer cleanly", async () => {
    const config = createMockAppConfig("full");
    let probeCount = 0;

    const supervisor = new TunnelSupervisor({
      config,
      pollIntervalMs: 15,
      healthUrlProbe: async () => {
        probeCount += 1;
        return true;
      },
      statusProbe: () => ({ ok: true, processRunning: true, healthy: true, ready: true, detail: "ok" }),
    });

    supervisor.start();
    expect(supervisor.getStats().status).toBe("running");

    await Bun.sleep(50);
    expect(probeCount).toBeGreaterThanOrEqual(2);

    supervisor.stop();
    expect(supervisor.getStats().status).toBe("stopped");

    const countAtStop = probeCount;
    await Bun.sleep(40);
    expect(probeCount).toBe(countAtStop);
  });

  test("server healthz exposes tunnel_supervisor stats and tunnel_auto_restarts", async () => {
    const config = createMockAppConfig("full");
    const mockSupervisor = new TunnelSupervisor({
      config,
      healthUrlProbe: async () => true,
      statusProbe: () => ({ ok: true, processRunning: true, healthy: true, ready: true, detail: "ok" }),
    });

    const server = startServer(config, {
      tunnelSupervisor: mockSupervisor,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(response.status).toBe(200);

      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.tunnel_auto_restarts).toBe(0);
      expect(body.last_tunnel_auto_restart_at).toBeNull();
      expect(body.tunnel_supervisor).toBeDefined();

      const sup = body.tunnel_supervisor as Record<string, unknown>;
      expect(sup.enabled).toBe(true);
      expect(sup.status).toBe("running");
    } finally {
      await server.stop(true);
      mockSupervisor.stop();
    }
  });

  test("server admin endpoint /admin/tunnel/restart triggers forced recovery", async () => {
    const config = createMockAppConfig("full");
    let forcedRestartCount = 0;

    const mockSupervisor = new TunnelSupervisor({
      config,
      healthUrlProbe: async () => true,
      statusProbe: () => ({ ok: true, processRunning: true, healthy: true, ready: true, detail: "ok" }),
      restartAction: async () => {
        forcedRestartCount += 1;
      },
    });

    const server = startServer(config, {
      tunnelSupervisor: mockSupervisor,
    });

    try {
      // Unauthorized call without token
      const unauthResponse = await fetch(`http://127.0.0.1:${server.port}/admin/tunnel/restart`, {
        method: "POST",
      });
      expect(unauthResponse.status).toBe(401);

      // Authorized call with bearer control token
      const authResponse = await fetch(`http://127.0.0.1:${server.port}/admin/tunnel/restart`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
        },
      });
      expect(authResponse.status).toBe(200);
      const resBody = await authResponse.json() as Record<string, unknown>;
      expect(resBody.status).toBe("ok");
      expect(resBody.recovered).toBe(true);
      expect(forcedRestartCount).toBe(1);
    } finally {
      await server.stop(true);
      mockSupervisor.stop();
    }
  });

  test("defaultHealthUrlProbe returns false when metrics report 502 error on MCP channel", async () => {
    let return502InMetrics = false;
    const mockHealthServer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/readyz") {
          return new Response("ready", { status: 200 });
        }
        if (path === "/metrics") {
          if (return502InMetrics) {
            const metrics502 = `
command_end_to_end_latency_milliseconds_count{channel="main",tunnel_service_status="200"} 73
command_end_to_end_latency_milliseconds_count{channel="main",tunnel_service_status="502"} 39
`;
            return new Response(metrics502, { status: 200 });
          }
          return new Response('command_end_to_end_latency_milliseconds_count{channel="main",tunnel_service_status="200"} 73\n', { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const url = `http://127.0.0.1:${mockHealthServer.port}`;
      // Healthy initially
      expect(await defaultHealthUrlProbe(url)).toBe(true);

      // Now simulate deadline retirement / 502 on channel
      return502InMetrics = true;
      expect(await defaultHealthUrlProbe(url)).toBe(false);
    } finally {
      mockHealthServer.stop(true);
    }
  });
});
