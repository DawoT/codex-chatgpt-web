import { existsSync } from "node:fs";
import type { AppConfig, BrowserInteractionMode } from "../config";
import { getConfigPath, loadConfigForSetup, tunnelConfigForInteractionMode } from "../config";
import type { ExistingFullSetupCredentials } from "./types";

export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): boolean {
  if (interactionMode === "manual") return false;
  return (
    refreshAccountCapabilities ||
    existing?.browserInteractionMode === "manual" ||
    existing?.browserHost !== "launcher" ||
    typeof existing.solAvailable !== "boolean" ||
    typeof existing.extraHighAvailable !== "boolean" ||
    typeof existing.proAvailable !== "boolean"
  );
}

export function existingFullSetupCredentials(
  existing: AppConfig | undefined,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full" ? tunnelConfigForInteractionMode(existing, interactionMode) : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

export function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

/**
 * Returns a canonical object whose JSON fingerprint captures every AppConfig field that affects
 * the running daemon's behavior. Any change here triggers a daemon restart. Keeping all tracked
 * fields in one place prevents silent drift when new AppConfig fields are added.
 */
function runtimeFingerprint(config: AppConfig): object {
  return {
    mode: config.mode,
    subagentProtocol: config.subagentProtocol,
    releaseVersion: config.releaseVersion,
    host: config.host,
    port: config.port,
    contextWindow: config.contextWindow,
    appName: config.appName,
    automaticAppName: config.automaticAppName,
    manualAppName: config.manualAppName,
    browserHost: config.browserHost,
    browserInteractionMode: config.browserInteractionMode,
    browserHostDescriptorPath: config.browserHostDescriptorPath,
    chromeExecutablePath: config.chromeExecutablePath,
    storageStatePath: config.storageStatePath,
    brokerSocketPath: config.brokerSocketPath,
    headed: config.headed,
    solAvailable: config.solAvailable,
    extraHighAvailable: config.extraHighAvailable,
    proAvailable: config.proAvailable,
    experimentalBiggerContext: config.experimentalBiggerContext,
    experimentalSkillAttachments: config.experimentalSkillAttachments,
    experimentalFreshConversationPerTurn: config.experimentalFreshConversationPerTurn,
    useSavedChats: config.useSavedChats,
    zeroRiskProEnabled: config.zeroRiskProEnabled,
    autoApproveToolCalls: config.autoApproveToolCalls,
    controlToken: config.controlToken,
    runtimeCommand: config.runtimeCommand,
    tunnel: config.tunnel,
    automaticTunnel: config.automaticTunnel,
    manualTunnel: config.manualTunnel,
    chatFirst: config.chatFirst,
    stallTimeoutSec: config.stallTimeoutSec,
    rateLimitRpm: config.rateLimitRpm,
  };
}

export function meaningfulRuntimeChange(before: AppConfig, after: AppConfig): boolean {
  return JSON.stringify(runtimeFingerprint(before)) !== JSON.stringify(runtimeFingerprint(after));
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (before?.mode !== "full" || after.mode !== "full") return false;
  const beforeTunnel = tunnelConfigForInteractionMode(before, before.browserInteractionMode);
  const afterTunnel = tunnelConfigForInteractionMode(after, after.browserInteractionMode);
  return (
    before.releaseVersion !== after.releaseVersion ||
    JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand) ||
    before.brokerSocketPath !== after.brokerSocketPath ||
    before.browserInteractionMode !== after.browserInteractionMode ||
    JSON.stringify(beforeTunnel) !== JSON.stringify(afterTunnel)
  );
}
