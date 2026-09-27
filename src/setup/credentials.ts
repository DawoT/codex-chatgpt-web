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
  return refreshAccountCapabilities
    || existing?.browserInteractionMode === "manual"
    || existing?.browserHost !== "launcher"
    || typeof existing.solAvailable !== "boolean"
    || typeof existing.extraHighAvailable !== "boolean"
    || typeof existing.proAvailable !== "boolean";
}

export function existingFullSetupCredentials(
  existing: AppConfig | undefined,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full"
    ? tunnelConfigForInteractionMode(existing, interactionMode)
    : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

export function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

export function meaningfulRuntimeChange(before: AppConfig, after: AppConfig): boolean {
  return JSON.stringify({
    mode: before.mode,
    subagentProtocol: before.subagentProtocol,
    releaseVersion: before.releaseVersion,
    host: before.host,
    port: before.port,
    contextWindow: before.contextWindow,
    appName: before.appName,
    automaticAppName: before.automaticAppName,
    manualAppName: before.manualAppName,
    browserHost: before.browserHost,
    browserInteractionMode: before.browserInteractionMode,
    browserHostDescriptorPath: before.browserHostDescriptorPath,
    chromeExecutablePath: before.chromeExecutablePath,
    storageStatePath: before.storageStatePath,
    brokerSocketPath: before.brokerSocketPath,
    headed: before.headed,
    solAvailable: before.solAvailable,
    extraHighAvailable: before.extraHighAvailable,
    proAvailable: before.proAvailable,
    experimentalBiggerContext: before.experimentalBiggerContext,
    experimentalSkillAttachments: before.experimentalSkillAttachments,
    experimentalFreshConversationPerTurn: before.experimentalFreshConversationPerTurn,
    useSavedChats: before.useSavedChats,
    zeroRiskProEnabled: before.zeroRiskProEnabled,
    autoApproveToolCalls: before.autoApproveToolCalls,
    controlToken: before.controlToken,
    runtimeCommand: before.runtimeCommand,
    tunnel: before.tunnel,
    automaticTunnel: before.automaticTunnel,
    manualTunnel: before.manualTunnel,
    chatFirst: before.chatFirst,
  }) !== JSON.stringify({
    mode: after.mode,
    subagentProtocol: after.subagentProtocol,
    releaseVersion: after.releaseVersion,
    host: after.host,
    port: after.port,
    contextWindow: after.contextWindow,
    appName: after.appName,
    automaticAppName: after.automaticAppName,
    manualAppName: after.manualAppName,
    browserHost: after.browserHost,
    browserInteractionMode: after.browserInteractionMode,
    browserHostDescriptorPath: after.browserHostDescriptorPath,
    chromeExecutablePath: after.chromeExecutablePath,
    storageStatePath: after.storageStatePath,
    brokerSocketPath: after.brokerSocketPath,
    headed: after.headed,
    solAvailable: after.solAvailable,
    extraHighAvailable: after.extraHighAvailable,
    proAvailable: after.proAvailable,
    experimentalBiggerContext: after.experimentalBiggerContext,
    experimentalSkillAttachments: after.experimentalSkillAttachments,
    experimentalFreshConversationPerTurn: after.experimentalFreshConversationPerTurn,
    useSavedChats: after.useSavedChats,
    zeroRiskProEnabled: after.zeroRiskProEnabled,
    autoApproveToolCalls: after.autoApproveToolCalls,
    controlToken: after.controlToken,
    runtimeCommand: after.runtimeCommand,
    tunnel: after.tunnel,
    automaticTunnel: after.automaticTunnel,
    manualTunnel: after.manualTunnel,
    chatFirst: after.chatFirst,
  });
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath
    || before.browserInteractionMode !== after.browserInteractionMode
    || JSON.stringify(before.tunnel) !== JSON.stringify(after.tunnel);
}
