import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
} from "../browser-login";
import {
  installCodexIntegration,
  preflightCodexIntegration,
  readCodexSubagentProtocol,
} from "../codex-integration";
import {
  getConfigPath,
  saveConfig,
  tunnelConfigForInteractionMode,
} from "../config";
import {
  DEV_CONFIG_PURPOSE,
  DEV_LAUNCHER_PROFILE,
} from "../dev-chat/constants";
import {
  assertServiceIdle,
  getServiceStatus,
  installService,
  removeLegacyRuntimeArtifacts,
  restartService,
  uninstallService,
} from "../service";
import {
  managedRuntimeKeyPath,
  stopTunnel,
  waitForTunnelReady,
} from "../tunnel";
import {
  getTunnelServiceStatus,
  installTunnelService,
  restartTunnelService,
  stopTunnelService,
  tunnelServiceDefinitionMatches,
  uninstallTunnelService,
} from "../tunnel-service";
import {
  loadExistingConfig,
  meaningfulRuntimeChange,
  tunnelWorkerRuntimeChanged,
} from "./credentials";
import {
  assertPortAvailable,
  baseConfig,
  inspectLauncherCapabilities,
  waitForProxy,
} from "./network";
import {
  bootstrapTunnelProfile,
  configureTunnel,
  setupChatFirstTunnelProfile,
} from "./tunnel-profile";
import type {
  DevProfileSetupResult,
  PreparedSetup,
  SetupOptions,
  SetupResult,
} from "./types";

export function prepareSetup(options: SetupOptions): PreparedSetup {
  const existing = loadExistingConfig();
  if (existing?.purpose === DEV_CONFIG_PURPOSE) {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = baseConfig(existing, {
    ...options,
    subagentProtocol: options.subagentProtocol
      ?? readCodexSubagentProtocol(existing?.subagentProtocol ?? "compatibility-v1"),
  });
  delete config.purpose;
  const launcherOwned = config.browserHost === "launcher";
  if (!launcherOwned && process.platform !== "darwin") {
    throw new Error(
      "Terminal-only managed Chrome setup currently requires macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
  return { existing, config, launcherOwned };
}

export function preflightSetup(options: SetupOptions): void {
  const { existing, config } = prepareSetup(options);
  if (config.mode === "full") {
    const saved = existing?.mode === "full"
      ? tunnelConfigForInteractionMode(existing, config.browserInteractionMode)
      : undefined;
    const tunnelId = options.tunnelId ?? saved?.tunnelId;
    if (!tunnelId) {
      throw new Error(
        `${config.browserInteractionMode === "manual" ? "Zero Risk" : "Automatic"} mode needs its own MCP Tunnel ID`,
      );
    }
    const savedKey = saved?.runtimeKeyFile;
    const managedKey = managedRuntimeKeyPath(config.browserInteractionMode);
    const hasRuntimeKey = Boolean(
      options.runtimeKeyValue
      || (options.runtimeKeyFile && existsSync(options.runtimeKeyFile))
      || (savedKey && existsSync(savedKey))
      || existsSync(managedKey),
    );
    if (!hasRuntimeKey) {
      throw new Error(
        `${config.browserInteractionMode === "manual" ? "Zero Risk" : "Automatic"} mode needs its own MCP runtime key`,
      );
    }
    const otherMode = config.browserInteractionMode === "manual" ? "automatic" : "manual";
    const other = existing?.mode === "full"
      ? tunnelConfigForInteractionMode(existing, otherMode)
      : undefined;
    if (other?.tunnelId === tunnelId) {
      throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
    }
  }
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const { existing, config, launcherOwned } = prepareSetup(options);
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  if (existing && options.restartService) config.controlToken = randomBytes(32).toString("base64url");
  const beforeService = getServiceStatus();
  if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
    if (!existing) {
      throw new Error("A legacy background service exists without a verifiable configuration; refusing automatic migration");
    }
    if (!options.restartService) {
      throw new Error(
        "Launcher ownership migration must stop the legacy background service. "
        + "Retry from the launcher after the active Codex task finishes.",
      );
    }
  }
  if (beforeService.loaded && !existing) {
    throw new Error("A codex-chatgpt-web service is loaded but its configuration is missing; refusing to replace an unverifiable process");
  }

  let loginCreated = false;
  let solAvailable: boolean | undefined = config.solAvailable;
  let extraHighAvailable: boolean | undefined = config.extraHighAvailable;
  let proAvailable: boolean | undefined = config.proAvailable;
  if (config.browserInteractionMode === "manual") {
    // The generic manual route is independent of account capabilities. The launcher may open the
    // authenticated surface, but setup must not inspect its model selector or infer availability.
  } else if (config.browserHost === "launcher") {
    if (options.forceLogin) throw new Error("Launcher browser login is owned by the launcher UI; --login cannot replace it");
    const capabilities = await inspectLauncherCapabilities(
      config,
      existing,
      options.refreshAccountCapabilities === true,
      "production",
    );
    solAvailable = capabilities.solAvailable;
    extraHighAvailable = capabilities.extraHighAvailable;
    proAvailable = capabilities.proAvailable;
  } else {
    const stored = storedBrowserLoginCapabilities(config);
    solAvailable = stored.solAvailable;
    extraHighAvailable = stored.extraHighAvailable;
    proAvailable = stored.proAvailable;
    const loginRequired = options.forceLogin || !browserLoginStateExists(config);
    const capabilityProbeRequired = !loginRequired
      && (options.refreshAccountCapabilities === true
        || existing?.browserInteractionMode === "manual"
        || solAvailable === undefined
        || extraHighAvailable === undefined
        || proAvailable === undefined);
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && !options.restartService) {
      throw new Error(
        "Setup must verify the browser account before changing the running daemon. "
        + "Rerun from a normal terminal with --restart-service after the active task finishes.",
      );
    }
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && existing) await assertServiceIdle(existing);
    if (loginRequired) {
      const login = await loginToChatGpt(config);
      solAvailable = login.solAvailable;
      extraHighAvailable = login.extraHighAvailable;
      proAvailable = login.proAvailable;
      loginCreated = true;
    } else if (capabilityProbeRequired) {
      const inspected = await inspectBrowserLoginCapabilities(config);
      solAvailable = inspected.solAvailable;
      extraHighAvailable = inspected.extraHighAvailable;
      proAvailable = inspected.proAvailable;
    }
  }
  config.solAvailable = solAvailable === true;
  config.extraHighAvailable = config.solAvailable && extraHighAvailable === true;
  config.proAvailable = config.solAvailable && proAvailable === true;
  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  const preliminaryChange = Boolean(existing && (meaningfulRuntimeChange(existing, config) || explicitTunnelChange || options.forceLogin));
  if (beforeService.loaded && preliminaryChange && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (beforeService.loaded && preliminaryChange && existing) await assertServiceIdle(existing);
  await configureTunnel(config, existing, options);

  const changedWhileLoaded = Boolean(existing && beforeService.loaded && meaningfulRuntimeChange(existing, config));
  if (changedWhileLoaded && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (changedWhileLoaded && !preliminaryChange && existing) await assertServiceIdle(existing);
  if (!beforeService.loaded) await assertPortAvailable(config.host, config.port);

  if (!launcherOwned) {
    saveConfig(config);
    installService(config);
    if (changedWhileLoaded && options.restartService && existing) await restartService(existing);
    await waitForProxy(config);
  }

  let tunnelReady: boolean | null = null;
  if (config.mode === "browser-only" && existing?.mode === "full") {
    const previousTunnelService = getTunnelServiceStatus();
    if (previousTunnelService.installed || previousTunnelService.loaded) await uninstallTunnelService();
    stopTunnel(existing);
  }
  if (config.mode === "full") {
    const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    const tunnelService = getTunnelServiceStatus();
    const needsProfile = !existsSync(profilePath);
    if (launcherOwned) {
      if (tunnelService.installed || tunnelService.loaded) await uninstallTunnelService();
    } else {
      const needsOwnershipMigration = !tunnelService.installed || !tunnelService.loaded || !tunnelServiceDefinitionMatches(config);
      if (needsOwnershipMigration || needsProfile) {
        await assertServiceIdle(config);
        if (tunnelService.loaded) await stopTunnelService();
        await bootstrapTunnelProfile(config);
        installTunnelService(config);
      } else if (refreshTunnelWorker) {
        await assertServiceIdle(config);
        await restartTunnelService();
      }
      const status = await waitForTunnelReady(config);
      if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
      tunnelReady = true;
      await setupChatFirstTunnelProfile(config);
    }
  }
  if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
    await uninstallService(existing!);
  }
  if (launcherOwned) saveConfig(config);
  const migratingTerminalRuntime = Boolean(
    launcherOwned && existing && existing.browserHost !== "launcher",
  );
  if (!migratingTerminalRuntime) removeLegacyRuntimeArtifacts(config);
  installCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });

  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated,
    serviceLoaded: launcherOwned ? false : getServiceStatus().loaded,
    tunnelReady,
    codexRestartRequired: true,
    connectorSetupRequired: config.mode === "full",
  };
}

/**
 * Configure the isolated launcher/browser/tunnel inputs used by the repository DEV harness.
 * This deliberately has no Codex integration, Responses listener, or system service; the DEV
 * launcher supervises only the isolated MCP tunnel after this transaction commits.
 */
export async function setupDevProfile(options: SetupOptions): Promise<DevProfileSetupResult> {
  const existing = loadExistingConfig();
  if (existing && existing.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("DEV profile home contains a non-DEV configuration; refusing to repurpose it");
  }
  if (!options.browserHostDescriptorPath) {
    throw new Error("DEV profile setup requires the isolated launcher browser descriptor");
  }
  const config = baseConfig(existing, options, DEV_LAUNCHER_PROFILE);
  if (config.browserHost !== "launcher") {
    throw new Error("DEV profile setup requires the desktop launcher browser host");
  }
  config.purpose = DEV_CONFIG_PURPOSE;
  if (config.browserInteractionMode === "automatic") {
    const capabilities = await inspectLauncherCapabilities(
      config,
      existing,
      options.refreshAccountCapabilities === true,
      DEV_LAUNCHER_PROFILE,
    );
    config.solAvailable = capabilities.solAvailable;
    config.extraHighAvailable = capabilities.solAvailable && capabilities.extraHighAvailable;
    config.proAvailable = capabilities.solAvailable && capabilities.proAvailable;
  }

  await configureTunnel(config, existing, options);
  const tunnelReady = config.mode === "full" ? false : null;
  saveConfig(config);
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    tunnelReady,
    connectorSetupRequired: config.mode === "full",
  };
}
