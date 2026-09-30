/**
 * Pure aggregation of the ChatGPT turn-liveness signals that browser-worker.ts used to compute
 * inline at six sites (waitForMultipartAcknowledgement, recoverStalledResponsePage and three
 * completion-loop sites): from one external-progress snapshot and an observation instant it
 * derives
 * - `externalProgressLive`: proven MCP activity that is recent enough to still outrank DOM
 *   health (`chatGptExternalProgressSuppressesDomHealth`),
 * - `externalToolCallsInFlight`: unresolved native tool calls that veto completion
 *   (`chatGptExternalToolCallsAreInFlight`),
 * - `multiChannelLivenessActive`: event-driven multi-channel liveness, fed the snapshot's
 *   lastProgressAt as the broker channel and claimed/tool activity as in-flight evidence
 *   (`isMultiChannelLivenessActive`).
 *
 * `now` is an explicit parameter instead of an internal `Date.now()` read so the classification
 * is deterministic and testable; the clock was already read at the call instant in every
 * production copy, so threading it through changes no observable behavior.
 */
import { type ChatGptExternalTurnProgressSnapshot, chatGptExternalToolCallsAreInFlight } from "../turn-progress";
import { chatGptExternalProgressSuppressesDomHealth } from "./dom-trackers";
import { isMultiChannelLivenessActive } from "./suspension-clock";

export interface ChatGptTurnLivenessSignals {
  externalProgressLive: boolean;
  externalToolCallsInFlight: boolean;
  multiChannelLivenessActive: boolean;
}

export function resolveTurnLivenessSignals(
  externalProgressSnapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): ChatGptTurnLivenessSignals {
  const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(externalProgressSnapshot, now);
  const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
  const multiChannelLivenessActive = isMultiChannelLivenessActive(
    {
      lastBrokerEventAt: externalProgressSnapshot?.lastProgressAt,
      activeToolCalls: externalProgressSnapshot?.activeToolCalls,
      inFlightCalls: externalToolCallsInFlight || externalProgressSnapshot?.claimed,
    },
    now,
  );
  return { externalProgressLive, externalToolCallsInFlight, multiChannelLivenessActive };
}
