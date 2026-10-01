import type { Page } from "playwright-core";
import {
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  type notifyLauncherTurn,
} from "../../../launcher-browser-host";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptRetainedConversationUnavailableError,
} from "../adapter-error";
import type { InteractiveBrowserTurnLock, InteractiveBrowserTurnMutex } from "../browser-mutex";
import type { BrowserTurn } from "../browser-worker";
import type { ResolvedBrowserConfig } from "./config";

/** Boundaries owned by the worker; the orchestrator owns only a single turn's lease lifecycle. */
export interface TurnOrchestratorDeps {
  config: Pick<ResolvedBrowserConfig, "browserHost" | "browserHostDescriptorPath" | "appName">;
  notifyLauncherTurn: typeof notifyLauncherTurn;
  acquireInteractive: InteractiveBrowserTurnMutex["acquire"];
  runBrowserTurn: (
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation?: boolean,
    trackUsage?: boolean,
    onInteractiveSettled?: () => void,
    acquireInteractive?: () => Promise<void>,
  ) => Promise<string>;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export class TurnOrchestrator {
  constructor(private readonly deps: TurnOrchestratorDeps) {}

  async run(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");

    let interactiveLock: InteractiveBrowserTurnLock | undefined;
    const acquireInteractive = async () => {
      if (interactiveLock) return;
      interactiveLock = await this.deps.acquireInteractive(turn.traceId, turn.abortSignal);
    };
    const releaseInteractive = () => {
      interactiveLock?.release();
      interactiveLock = undefined;
    };

    if (this.deps.config.browserHost !== "launcher") {
      try {
        const answer = await this.deps.runBrowserTurn(
          turn,
          undefined,
          undefined,
          false,
          false,
          releaseInteractive,
          acquireInteractive,
        );
        await turn.onResultReady?.(answer);
        return answer;
      } finally {
        releaseInteractive();
      }
    }

    let surfaceId: string | undefined;
    let surfaceClaimed = false;
    let resultReadyConfirmed = false;
    let reused = false;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let turnFailed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    try {
      const lease = await this.deps
        .notifyLauncherTurn(
          this.deps.config.browserHostDescriptorPath!,
          {
            phase: "start",
            traceId: turn.traceId,
            helperPid: process.pid,
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.conversationKey &&
            (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation)
              ? { connectorIdentity: this.deps.config.appName }
              : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
          },
          undefined,
          turn.abortSignal,
        )
        .catch((error) => {
          if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
          if (error instanceof LauncherRetainedConversationUnavailableError) {
            throw chatGptRetainedConversationUnavailableError();
          }
          throw error;
        });
      surfaceId = lease.surfaceId;
      reused = lease.reused === true;
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      // Arm the heartbeat before any user callback runs: onSurfaceLeased/onPreparedSelected can
      // take arbitrarily long, and the launcher revokes a surface that stops receiving
      // heartbeats, so slow callbacks must not burn the liveness budget.
      const sendHeartbeat = () => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        void this.deps
          .notifyLauncherTurn(
            this.deps.config.browserHostDescriptorPath!,
            {
              phase: "heartbeat",
              traceId: turn.traceId,
              helperPid: process.pid,
            },
            this.deps.heartbeatTimeoutMs,
          )
          .catch((error) => {
            const now = Date.now();
            if (now - lastHeartbeatFailureAt < 30_000) return;
            lastHeartbeatFailureAt = now;
            console.warn(
              `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            heartbeatInFlight = false;
          });
      };
      heartbeatTimer = setInterval(sendHeartbeat, this.deps.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      await turn.onSurfaceLeased?.(surfaceId);
      surfaceClaimed = true;
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      await turn.onPreparedSelected?.(reused);
      const answer = await this.deps.runBrowserTurn(
        turn,
        surfaceId,
        undefined,
        reused,
        lease.trackUsage === true,
        releaseInteractive,
        acquireInteractive,
      );
      await turn.onResultReady?.(answer);
      resultReadyConfirmed = turn.onResultReady !== undefined;
      return answer;
    } catch (error) {
      turnFailed = true;
      terminal =
        error instanceof ChatGptCompactionHandoffAccepted
          ? "completed"
          : (error instanceof DOMException && error.name === "AbortError") ||
              (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
            ? "aborted"
            : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      releaseInteractive();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (surfaceId) {
        try {
          const release = await this.deps.notifyLauncherTurn(this.deps.config.browserHostDescriptorPath!, {
            phase: "end",
            traceId: turn.traceId,
            helperPid: process.pid,
            status: terminal,
            ...(terminalMessage ? { message: terminalMessage } : {}),
            ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
            ...(resultReadyConfirmed ? { resultPersisted: true } : {}),
            ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
              ? { connectorBound: true }
              : {}),
          });
          if (surfaceClaimed && !(terminal === "completed" && turn.retainConversation && turn.conversationKey)) {
            await turn.onSurfaceReleased?.(surfaceId);
          }
          if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
        } catch (controlError) {
          if (controlError instanceof ChatGptWebAdapterError && controlError.code === "client_cancelled") {
            throw controlError;
          }
          if (!turnFailed) throw controlError;
          console.error(
            `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
          );
        }
      }
    }
  }
}
