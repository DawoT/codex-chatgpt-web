import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { connectTunnel, stopTunnel, tunnelStatus, waitForTunnelReady, type TunnelRuntimeStatus } from "./tunnel";
import { getTunnelServiceStatus, restartTunnelService } from "./tunnel-service";

export type TunnelSupervisorStatus =
  | "idle"
  | "running"
  | "recovering"
  | "degraded"
  | "stopped"
  | "disabled";

export interface TunnelSupervisorStats {
  enabled: boolean;
  status: TunnelSupervisorStatus;
  auto_restarts: number;
  last_auto_restart_at: string | null;
  consecutive_failures: number;
  last_probe_at: string | null;
  last_probe_ok: boolean | null;
  last_probe_detail: string | null;
  last_error: string | null;
}

export interface TunnelSupervisorOptions {
  config: AppConfig;
  pollIntervalMs?: number;
  backoffDelaysMs?: number[];
  maxConsecutiveRestarts?: number;
  statusProbe?: (config: AppConfig) => Promise<TunnelRuntimeStatus> | TunnelRuntimeStatus;
  restartAction?: (config: AppConfig) => Promise<void> | void;
  healthUrlProbe?: (url: string) => Promise<boolean>;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export function resolveTunnelHealthUrl(config: AppConfig): string | undefined {
  if (!config.tunnel) return undefined;
  const settings = config.tunnel;

  // 1. Try reading the url_file path declared in profile YAML
  const profileFile = join(settings.profileDir, `${settings.profileName}.yaml`);
  if (existsSync(profileFile)) {
    try {
      const raw = readFileSync(profileFile, "utf8");
      const parsed = JSON.parse(raw) as { health?: { url_file?: string } };
      if (typeof parsed?.health?.url_file === "string" && existsSync(parsed.health.url_file)) {
        const url = readFileSync(parsed.health.url_file, "utf8").trim();
        if (/^https?:\/\/127\.0\.0\.1:\d+/.test(url)) return url;
      }
    } catch {
      // Ignore parse or read errors
    }
  }

  // 2. Try default state directory convention
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const fallbackUrlFile = join(stateRoot, "tunnel-client", "health", `${settings.alias}.url`);
  if (existsSync(fallbackUrlFile)) {
    try {
      const url = readFileSync(fallbackUrlFile, "utf8").trim();
      if (/^https?:\/\/127\.0\.0\.1:\d+/.test(url)) return url;
    } catch {
      // Ignore read errors
    }
  }

  return undefined;
}

export async function defaultHealthUrlProbe(url: string, timeoutMs = 2_000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = url.endsWith("/") ? `${url}readyz` : `${url}/readyz`;
    const response = await fetch(target, { signal: controller.signal });
    if (response.status !== 200) return false;

    // Check tunnel metrics for 502 status indicating retired stdio channel or broken upstream
    const metricsTarget = url.endsWith("/") ? `${url}metrics` : `${url}/metrics`;
    try {
      const metricsResponse = await fetch(metricsTarget, { signal: controller.signal });
      if (metricsResponse.status === 200) {
        const text = await metricsResponse.text();
        const match502 = text.match(/tunnel_service_status="502"[^}]*\}\s+(\d+)/);
        if (match502 && parseInt(match502[1], 10) > 0) {
          return false;
        }
      }
    } catch {
      // Best-effort check; do not fail if metrics endpoint is temporarily unreachable
    }

    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function defaultRestartAction(config: AppConfig): Promise<void> {
  if (process.platform === "darwin" && getTunnelServiceStatus().installed) {
    await restartTunnelService();
  } else {
    try {
      stopTunnel(config);
    } catch {
      // Ignore failure to stop already dead process
    }
    connectTunnel(config);
  }
  const status = await waitForTunnelReady(config, 15_000);
  if (!status.ok) {
    throw new Error(`Tunnel did not become healthy after restart: ${status.detail}`);
  }
}

export class TunnelSupervisor {
  private readonly config: AppConfig;
  private readonly pollIntervalMs: number;
  private readonly backoffDelaysMs: number[];
  private readonly maxConsecutiveRestarts: number;
  private readonly statusProbe: (config: AppConfig) => Promise<TunnelRuntimeStatus> | TunnelRuntimeStatus;
  private readonly restartAction: (config: AppConfig) => Promise<void> | void;
  private readonly healthUrlProbe: (url: string) => Promise<boolean>;
  private readonly logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  private enabled: boolean;
  private status: TunnelSupervisorStatus;
  private autoRestarts = 0;
  private lastAutoRestartAt: string | null = null;
  private consecutiveFailures = 0;
  private lastProbeAt: string | null = null;
  private lastProbeOk: boolean | null = null;
  private lastProbeDetail: string | null = null;
  private lastError: string | null = null;

  private pollTimer?: ReturnType<typeof setInterval>;
  private recoveryPromise?: Promise<boolean>;

  constructor(options: TunnelSupervisorOptions) {
    this.config = options.config;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.backoffDelaysMs = options.backoffDelaysMs ?? [1_000, 2_000, 5_000];
    this.maxConsecutiveRestarts = options.maxConsecutiveRestarts ?? 3;
    this.restartAction = options.restartAction ?? (cfg => defaultRestartAction(cfg));
    this.healthUrlProbe = options.healthUrlProbe ?? (url => defaultHealthUrlProbe(url));
    this.statusProbe = options.statusProbe ?? (async cfg => {
      const status = tunnelStatus(cfg);
      if (!status.ok) return status;
      const healthUrl = resolveTunnelHealthUrl(cfg);
      if (healthUrl) {
        try {
          const isHealthy = await this.healthUrlProbe(healthUrl);
          if (!isHealthy) {
            return {
              ok: false,
              processRunning: status.processRunning,
              healthy: false,
              ready: false,
              state: status.state,
              detail: "tunnel health probe failed (endpoint unreachable or 502 error detected)",
            };
          }
        } catch {}
      }
      return status;
    });
    this.logger = options.logger ?? {
      info: msg => console.info(`[tunnel-supervisor] ${msg}`),
      warn: msg => console.warn(`[tunnel-supervisor] ${msg}`),
      error: msg => console.error(`[tunnel-supervisor] ${msg}`),
    };

    const isFullWithTunnel = this.config.mode === "full" && Boolean(this.config.tunnel);
    this.enabled = isFullWithTunnel;
    this.status = isFullWithTunnel ? "idle" : "disabled";
  }

  getStats(): TunnelSupervisorStats {
    return {
      enabled: this.enabled,
      status: this.status,
      auto_restarts: this.autoRestarts,
      last_auto_restart_at: this.lastAutoRestartAt,
      consecutive_failures: this.consecutiveFailures,
      last_probe_at: this.lastProbeAt,
      last_probe_ok: this.lastProbeOk,
      last_probe_detail: this.lastProbeDetail,
      last_error: this.lastError,
    };
  }

  start(): void {
    if (!this.enabled) return;
    if (this.pollTimer) return;

    this.status = "running";
    this.pollTimer = setInterval(() => {
      void this.probeAndRecover().catch(err => {
        this.logger.error(`Periodic probe failure: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollIntervalMs);

    // Allow process to exit cleanly if timer is running
    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.enabled) {
      this.status = "stopped";
    }
  }

  async probe(): Promise<TunnelRuntimeStatus> {
    if (!this.enabled) {
      return {
        ok: false,
        processRunning: false,
        healthy: false,
        ready: false,
        detail: "Tunnel supervisor is disabled (browser-only mode or missing tunnel config)",
      };
    }

    const at = new Date().toISOString();
    this.lastProbeAt = at;

    // 1. Fast HTTP probe if health URL is resolvable
    const healthUrl = resolveTunnelHealthUrl(this.config);
    if (healthUrl) {
      try {
        const isHealthy = await this.healthUrlProbe(healthUrl);
        if (isHealthy) {
          this.lastProbeOk = true;
          this.lastProbeDetail = "http readyz ok";
          return {
            ok: true,
            processRunning: true,
            healthy: true,
            ready: true,
            state: "ready",
            detail: "http readyz ok",
          };
        }
      } catch {
        // Fall back to status probe
      }
    }

    // 2. Fallback to process/inventory probe
    try {
      const result = await this.statusProbe(this.config);
      this.lastProbeOk = result.ok;
      this.lastProbeDetail = result.detail;
      return result;
    } catch (error) {
      const detail = `Status probe threw: ${error instanceof Error ? error.message : String(error)}`;
      this.lastProbeOk = false;
      this.lastProbeDetail = detail;
      return {
        ok: false,
        processRunning: false,
        healthy: false,
        ready: false,
        detail,
      };
    }
  }

  async probeAndRecover(): Promise<boolean> {
    const status = await this.probe();
    if (status.ok) {
      if (this.status === "recovering" || this.status === "degraded") {
        this.status = "running";
      }
      return true;
    }
    return this.recover(false, status.detail);
  }

  async recover(force = false, cause?: string): Promise<boolean> {
    if (!this.enabled) return false;

    // Mutex: deduplicate concurrent recovery runs
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }

    this.recoveryPromise = this.performRecovery(force, cause).finally(() => {
      this.recoveryPromise = undefined;
    });

    return this.recoveryPromise;
  }

  private async performRecovery(force: boolean, cause?: string): Promise<boolean> {
    const initialStatus = this.status;
    this.status = "recovering";
    const reason = cause || this.lastProbeDetail || (force ? "operator forced recovery" : "probe detected failure");
    this.logger.warn(`Tunnel is down (${reason}). Initiating auto-recovery sequence...`);

    let attempt = 0;
    const maxAttempts = this.maxConsecutiveRestarts;

    while (attempt < maxAttempts) {
      const delayMs = this.backoffDelaysMs[attempt] ?? this.backoffDelaysMs[this.backoffDelaysMs.length - 1] ?? 1_000;
      attempt += 1;

      if (delayMs > 0) {
        await new Promise(res => setTimeout(res, delayMs));
      }

      this.logger.info(`Auto-recovery attempt ${attempt}/${maxAttempts} executing restart...`);

      try {
        await this.restartAction(this.config);

        // Verify that tunnel is now healthy
        const verified = await this.probe();
        if (verified.ok) {
          this.autoRestarts += 1;
          this.lastAutoRestartAt = new Date().toISOString();
          this.consecutiveFailures = 0;
          this.status = "running";
          this.lastError = null;
          this.logger.info(`Auto-recovery succeeded on attempt ${attempt}. Tunnel is healthy.`);
          return true;
        }

        this.lastError = `Restart attempt ${attempt} completed but tunnel status probe reported: ${verified.detail}`;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.lastError = `Restart attempt ${attempt} failed: ${errorMsg}`;
        this.logger.warn(this.lastError);
      }
    }

    this.consecutiveFailures += 1;
    this.status = "degraded";
    this.logger.error(`Tunnel auto-recovery exhausted all ${maxAttempts} attempts. Status transitioned to degraded.`);
    return false;
  }
}
