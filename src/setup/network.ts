import { createServer } from "node:net";
import type { AppConfig } from "../config";
import {
  currentRuntimeCommand,
  defaultBrokerEndpoint,
  defaultConfig,
  resolveInteractionConnectorIdentities,
} from "../config";
import { inspectLauncherBrowserHost } from "../launcher-browser-host";
import { VERSION } from "../version";
import { launcherCapabilityProbeRequired } from "./credentials";
import type { SetupOptions } from "./types";

export async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectAvailable(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? rejectAvailable(error) : resolveAvailable()));
  });
}

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === "codex-chatgpt-web"
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true;
}

export async function waitForProxy(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (setupProxyIsReady(body, config)) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Responses proxy did not become ready: ${lastError}`);
}

export function baseConfig(
  existing: AppConfig | undefined,
  options: SetupOptions,
  profile: "production" | "development" = "production",
): AppConfig {
  const config = existing ? structuredClone(existing) : defaultConfig(options.mode);
  config.mode = options.mode;
  if (options.browserInteractionMode) config.browserInteractionMode = options.browserInteractionMode;
  Object.assign(config, resolveInteractionConnectorIdentities(
    config.browserInteractionMode,
    profile,
  ));
  if (options.subagentProtocol) config.subagentProtocol = options.subagentProtocol;
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
    config.port = options.port;
  }
  if (options.chromeExecutablePath) config.chromeExecutablePath = options.chromeExecutablePath;
  if (options.browserHostDescriptorPath) {
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = options.browserHostDescriptorPath;
    config.brokerSocketPath = defaultBrokerEndpoint();
  } else if (options.chromeExecutablePath) {
    config.browserHost = "managed-chrome";
    delete config.browserHostDescriptorPath;
  }
  if (options.autoApproveToolCalls !== undefined) config.autoApproveToolCalls = options.autoApproveToolCalls;
  if (options.experimentalSkillAttachments !== undefined) {
    config.experimentalSkillAttachments = options.experimentalSkillAttachments;
  }
  if (options.useSavedChats !== undefined) config.useSavedChats = options.useSavedChats;
  if (options.experimentalFreshConversationPerTurn !== undefined) {
    config.experimentalFreshConversationPerTurn = options.experimentalFreshConversationPerTurn;
  }
  if (options.experimentalBiggerContext !== undefined) {
    config.experimentalBiggerContext = options.experimentalBiggerContext;
  }
  if (options.zeroRiskProEnabled !== undefined) {
    if (config.browserInteractionMode !== "manual") {
      throw new Error("Zero Risk Pro can be configured only with --zero-risk-browser-interaction");
    }
    config.zeroRiskProEnabled = options.zeroRiskProEnabled;
  }
  if (config.browserInteractionMode === "manual") {
    if (options.experimentalFreshConversationPerTurn === true) {
      throw new Error("Fresh browser conversations per turn is available only in automatic mode");
    }
    if (options.refreshAccountCapabilities) {
      throw new Error("Zero Risk cannot refresh account capabilities");
    }
    if (options.forceLogin) {
      throw new Error("Zero Risk uses the launcher's existing ChatGPT session; --login is unavailable");
    }
    if (options.experimentalSkillAttachments === true) {
      throw new Error("Zero Risk does not support Skills as files");
    }
    if (options.experimentalBiggerContext === true) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (config.mode !== "full") {
      throw new Error("Zero Risk requires --full so Codex Zero Risk can signal start, tools, and completion");
    }
    if (config.browserHost !== "launcher") {
      throw new Error("Zero Risk requires the Launcher; pass --browser-host-descriptor from the running Launcher");
    }
    config.experimentalBiggerContext = false;
    config.experimentalSkillAttachments = false;
  }
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

export async function inspectLauncherCapabilities(
  config: AppConfig,
  existing: AppConfig | undefined,
  refreshAccountCapabilities: boolean,
  expectedProfile: "production" | "development",
): Promise<{ solAvailable: boolean; extraHighAvailable: boolean; proAvailable: boolean }> {
  const detectCapabilities = launcherCapabilityProbeRequired(
    existing,
    refreshAccountCapabilities,
    config.browserInteractionMode,
  );
  const inspected = await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, {
    detectCapabilities,
    expectedProfile,
  });
  return {
    solAvailable: detectCapabilities ? inspected.solAvailable === true : existing!.solAvailable,
    extraHighAvailable: detectCapabilities ? inspected.extraHighAvailable === true : existing!.extraHighAvailable === true,
    proAvailable: detectCapabilities ? inspected.proAvailable === true : existing!.proAvailable,
  };
}
