import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
} from "../../../config";
import type { CodexProviderConfig } from "../../../types";

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
  useSavedChats: boolean;
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
    useSavedChats: configured.useSavedChats === true,
  };
}
