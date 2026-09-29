import type { Browser, BrowserContext, Page } from "playwright-core";

export const LAUNCHER_BROWSER_HOST_KIND = "codex-web-gpt-launcher";
export const LAUNCHER_BROWSER_IDLE_URL =
  "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3Ctitle%3ECodex%20Web%20GPT%3C%2Ftitle%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E#codex-web-gpt-browser-host";
export type LauncherBrowserHostProfile = "production" | "development";

export class LauncherBrowserTurnCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherBrowserTurnCancelledError";
  }
}

export class LauncherRetainedConversationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherRetainedConversationUnavailableError";
  }
}

export class LauncherManualTurnTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnTimedOutError";
  }
}

export class LauncherManualTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherManualTurnFailedError";
  }
}

export interface LauncherBrowserHostDescriptor {
  version: 3;
  kind: typeof LAUNCHER_BROWSER_HOST_KIND;
  profile: LauncherBrowserHostProfile;
  pid: number;
  endpoint: string;
  control: {
    endpoint: string;
    token: string;
  };
  helper: {
    executable: string;
    script: string;
  };
  partition: string;
  idleUrl: string;
  surfaceId: string;
  surfaceTargets: Record<string, string>;
  createdAt: string;
}

export interface LauncherBrowserConnection {
  descriptor: LauncherBrowserHostDescriptor;
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export const LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS = 30_000;
export const LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS = 120_000;

export type LauncherTurnActivity =
  | {
      phase: "usage";
      traceId: string;
      helperPid: number;
      receipt?: {
        id: string;
        accountKey: string;
        model: "gpt-6-pro" | "gpt-5.6-pro" | "pro-unknown" | "other";
        at: number;
      };
      trackingError?: "account-unavailable";
    }
  | {
      phase: "start";
      traceId: string;
      helperPid: number;
      conversationKey?: string;
      connectorIdentity?: string;
      requireRetainedConversation?: boolean;
      compaction?: boolean;
    }
  | {
      phase: "heartbeat";
      traceId: string;
      helperPid: number;
      refreshViewport?: boolean;
    }
  | {
      phase: "end";
      traceId: string;
      helperPid: number;
      status: "completed" | "failed" | "aborted";
      message?: string;
      retain?: boolean;
      connectorBound?: boolean;
      resultPersisted?: boolean;
    };

export const LAUNCHER_TURN_START_TIMEOUT_MS = 30 * 60_000;
export const LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS = 10_000;
export const LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
export const LAUNCHER_TURN_END_TIMEOUT_MS = 15_000;

export interface LauncherManualTurnOwner {
  traceId: string;
  helperPid: number;
}

export interface LauncherManualTurnStart extends LauncherManualTurnOwner {
  prompt: string;
  resumePrompt?: string;
  conversationKey?: string;
  compaction?: true;
}

export interface LauncherManualTurnLease {
  tabId: string;
  reused: boolean;
  deadlineAt: string | null;
  state: "awaiting-user" | "sent" | "running" | "completed";
}

export interface LauncherManualTurnEnd extends LauncherManualTurnOwner {
  status: "completed" | "failed" | "aborted";
  retain?: boolean;
}

export interface LauncherManualTurnTerminal {
  status: "cancelled" | "failed";
}

export const LAUNCHER_MANUAL_TURN_START_TIMEOUT_MS = 10_000;
export const LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS = 40_000;
export const LAUNCHER_MANUAL_TURN_END_TIMEOUT_MS = 15_000;
