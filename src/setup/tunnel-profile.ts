import { existsSync, mkdirSync } from "node:fs";
import type { AppConfig, TunnelConfig } from "../config";
import { DEV_CONFIG_PURPOSE, DEV_TUNNEL_BASE_NAME } from "../dev-chat/constants";
import { runCommand } from "../process";
import {
  chatFirstMcpCommand,
  connectTunnel,
  createTunnelConfig,
  installRuntimeKey,
  installRuntimeKeyBytes,
  installTunnelClient,
  managedRuntimeKeyPath,
  stopTunnel,
  TUNNEL_READY_TIMEOUT_MS,
  tunnelCommandOutput,
  tunnelConnectLaunchError,
  waitForTunnelReady,
} from "../tunnel";
import type { SetupOptions } from "./types";

export async function configureTunnel(
  config: AppConfig,
  existing: AppConfig | undefined,
  options: SetupOptions,
): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    delete config.automaticTunnel;
    delete config.manualTunnel;
    return;
  }
  const interactionMode = config.browserInteractionMode;
  const legacyTunnel =
    existing?.mode === "full" && !existing.automaticTunnel && !existing.manualTunnel ? existing.tunnel : undefined;
  let automaticTunnel = existing?.automaticTunnel ?? legacyTunnel;
  let manualTunnel = existing?.manualTunnel;
  const existingTunnel = interactionMode === "manual" ? manualTunnel : automaticTunnel;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own Tunnel ID`);
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  const managedKeyFile = managedRuntimeKeyPath(interactionMode);
  if ((!runtimeKeyFile || !existsSync(runtimeKeyFile)) && existsSync(managedKeyFile)) {
    runtimeKeyFile = managedKeyFile;
  }
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile, interactionMode);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue, interactionMode);
  if (runtimeKeyFile && runtimeKeyFile !== managedKeyFile && existsSync(runtimeKeyFile)) {
    runtimeKeyFile = installRuntimeKey(runtimeKeyFile, interactionMode);
  }
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own runtime key`);
  }
  const installedBinary = await installTunnelClient();
  const productionProfileName = interactionMode === "manual" ? "codex-chatgpt-web-zero-risk" : "codex-chatgpt-web";
  const profileName =
    config.purpose === DEV_CONFIG_PURPOSE
      ? interactionMode === "manual"
        ? `${DEV_TUNNEL_BASE_NAME}-zero-risk`
        : DEV_TUNNEL_BASE_NAME
      : productionProfileName;
  const configuredTunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName,
    alias: profileName,
  });
  const otherTunnel = interactionMode === "manual" ? automaticTunnel : manualTunnel;
  if (otherTunnel?.tunnelId === configuredTunnel.tunnelId) {
    throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
  }
  if (interactionMode === "manual") manualTunnel = configuredTunnel;
  else automaticTunnel = configuredTunnel;
  config.tunnel = configuredTunnel;
  if (automaticTunnel) config.automaticTunnel = automaticTunnel;
  else delete config.automaticTunnel;
  if (manualTunnel) config.manualTunnel = manualTunnel;
  else delete config.manualTunnel;
}

export async function bootstrapTunnelProfile(config: AppConfig): Promise<void> {
  let bootstrapError: unknown;
  try {
    connectTunnel(config);
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
  } catch (error) {
    bootstrapError = error;
  }
  try {
    stopTunnel(config);
  } catch (stopError) {
    if (bootstrapError) {
      const primary = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      const cleanup = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primary}; temporary tunnel cleanup also failed: ${cleanup}`);
    }
    throw stopError;
  }
  if (bootstrapError) throw bootstrapError;
}

export const CHAT_FIRST_TUNNEL_PROFILE = "codex-chatgpt-web-chat-first";

export function chatFirstTunnelDetail(value: string): string {
  return value
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

/**
 * Best-effort registration of the optional chat-first tunnel profile. It reuses the primary
 * tunnel's pinned tunnel-client binary, Tunnel ID, runtime key, and profile directory under the
 * dedicated `codex-chatgpt-web-chat-first` profile/alias and points tunnel-client at the
 * token-free chat-first MCP contract via chatFirstMcpCommand.
 *
 * The operation is strictly isolated from the primary connector: any failure is reported on
 * stderr and setup continues with the primary tunnel profile untouched (never stopped,
 * re-registered, or rewritten). Launcher-owned setups delegate profile creation to the launcher
 * supervisor and do not call this function.
 *
 * Returns true when the chat-first runtime completed a healthy, ready launch.
 */
export async function setupChatFirstTunnelProfile(config: AppConfig): Promise<boolean> {
  if (config.mode !== "full" || !config.tunnel || config.chatFirst?.enabled !== true) return false;
  const settings: TunnelConfig = {
    ...config.tunnel,
    profileName: CHAT_FIRST_TUNNEL_PROFILE,
    alias: CHAT_FIRST_TUNNEL_PROFILE,
  };
  try {
    mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
    const result = runCommand(
      settings.binaryPath,
      [
        "runtimes",
        "connect",
        "--alias",
        settings.alias,
        "--profile",
        settings.profileName,
        "--profile-dir",
        settings.profileDir,
        "--tunnel-client-bin",
        settings.binaryPath,
        "--tunnel-id",
        settings.tunnelId,
        "--runtime-api-key",
        `file:${settings.runtimeKeyFile}`,
        "--mcp-command",
        chatFirstMcpCommand(config),
        "--json",
      ],
      { timeout: TUNNEL_READY_TIMEOUT_MS },
    );
    const structuredOutput = result.stdout.trim();
    const launchError = structuredOutput ? tunnelConnectLaunchError(structuredOutput) : undefined;
    if (result.status !== 0) {
      const detail =
        launchError && launchError !== "tunnel-client returned non-JSON connect output"
          ? launchError
          : chatFirstTunnelDetail(tunnelCommandOutput(result) || `exit ${result.status}`);
      throw new Error(`chat-first tunnel registration failed: ${detail}`);
    }
    if (launchError) throw new Error(`chat-first tunnel runtime exited during launch: ${launchError}`);
    const status = await waitForTunnelReady({ ...config, tunnel: settings });
    if (!status.ok) {
      throw new Error(`chat-first tunnel runtime did not become healthy and ready: ${status.detail}`);
    }
    return true;
  } catch (error) {
    console.error(
      `[codex-chatgpt-web] chat-first tunnel profile was not registered; continuing without it: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
