import type {
  LauncherManualTurnEnd,
  LauncherManualTurnOwner,
  LauncherManualTurnStart,
} from "../../../launcher-browser-host";
import type { TurnBrokerOwner } from "../turn-broker";
import type { SubagentConcurrencyGovernor } from "../concurrency";

/** Keep the Responses bridge alive during every awaited phase of a browser turn. */
export const CHATGPT_WEB_ADAPTER_HEARTBEAT_MS = 10_000;
/** Accelerated heartbeat interval for compaction turns to prevent stall timeouts during deep summarization. */
export const CHATGPT_WEB_COMPACTION_HEARTBEAT_MS = 3_000;

export interface ChatGptZeroRiskManualControl {
  start(descriptorPath: string, activity: LauncherManualTurnStart): Promise<unknown>;
  waitSent(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
  waitTerminal(
    descriptorPath: string,
    owner: LauncherManualTurnOwner,
    options?: { abortSignal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ status: "cancelled" | "failed" }>;
  markStarted(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
  end(descriptorPath: string, activity: LauncherManualTurnEnd): Promise<unknown>;
  cancel(descriptorPath: string, owner: LauncherManualTurnOwner): Promise<void>;
}

export interface ChatGptAdapterDependencies {
  broker?: TurnBrokerOwner;
  zeroRiskManualControl?: ChatGptZeroRiskManualControl;
  subagentGovernor?: SubagentConcurrencyGovernor;
}
