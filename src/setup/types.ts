import type { AppConfig, BrowserInteractionMode, RuntimeMode, SubagentProtocol } from "../config";

export interface SetupOptions {
  mode: RuntimeMode;
  browserInteractionMode?: BrowserInteractionMode;
  subagentProtocol?: SubagentProtocol;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  experimentalBiggerContext?: boolean;
  experimentalSkillAttachments?: boolean;
  experimentalFreshConversationPerTurn?: boolean;
  useSavedChats?: boolean;
  zeroRiskProEnabled?: boolean;
  replaceCodexRoute?: boolean;
  restartService?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: RuntimeMode;
  configPath: string;
  loginCreated: boolean;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  codexRestartRequired: true;
  connectorSetupRequired: boolean;
}

export interface DevProfileSetupResult {
  mode: RuntimeMode;
  configPath: string;
  tunnelReady: boolean | null;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export interface PreparedSetup {
  existing: AppConfig | undefined;
  config: AppConfig;
  launcherOwned: boolean;
}
