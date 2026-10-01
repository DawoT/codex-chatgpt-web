import { diagnosticCode } from "../../diagnostics/errors";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "./adapter-error";
import { ChatGptBrowserObservationTimeoutError } from "./browser/suspension-clock";

export type TurnTerminationCause =
  | "user_cancelled"
  | "handoff_accepted"
  | "deadline"
  | "transport"
  | "internal_failure";

/** The typed abort reason wins over the generic AbortError produced by a raced browser wait. */
export function classifyTurnTermination(error: unknown, signal?: AbortSignal): TurnTerminationCause {
  const reason = signal?.aborted ? signal.reason : error;
  if (reason instanceof ChatGptCompactionHandoffAccepted || error instanceof ChatGptCompactionHandoffAccepted) {
    return "handoff_accepted";
  }
  for (const candidate of [reason, error]) {
    const code = diagnosticCode(candidate);
    if (code === "user_cancelled" || code === "client_cancelled") return "user_cancelled";
    if (code === "handoff_accepted") return "handoff_accepted";
    if (code === "stage_timeout" || code === "transport_timeout") return "deadline";
    if (
      ["transport_closed", "transport_reset", "transport_pipe", "transport_refused", "transport_error"].includes(code)
    )
      return "transport";
    if (candidate instanceof ChatGptBrowserObservationTimeoutError) return "deadline";
    if (candidate instanceof ChatGptWebAdapterError) {
      if (/(?:timeout|deadline)/.test(candidate.code)) return "deadline";
      if (candidate.code === "client_cancelled") return "user_cancelled";
      if (/transport|disconnected/.test(candidate.code)) return "transport";
    }
    if (candidate instanceof Error && candidate.name === "TimeoutError") return "deadline";
  }
  return "internal_failure";
}
