import type { HostSession } from "./host-state";

/** Metadata only: idle is not success, and host command settlement is outside this scope. */
export function inspectHostTurn(session: HostSession, turnId: string) {
  const turn = session.turns.get(turnId);
  const admitting = session.admitting?.turnId === turnId;
  let pendingCalls = 0;
  for (const call of session.calls.values()) {
    if (call.turnId === turnId && call.result === undefined) pendingCalls += 1;
  }
  const state = turn?.cancelled
    ? "cancelled"
    : admitting
      ? "admitting"
      : turn?.active
        ? "active"
        : turn
          ? "idle"
          : "unknown";
  return {
    session_id: session.id,
    turn_id: turnId,
    state,
    cancellation: turn?.cancellation ?? null,
    // Only accepted requests consume a sequence; a pending body does not.
    request_sequence: turn?.requestSequence ?? null,
    last_completed_sequence: turn?.completedSequence ?? null,
    last_completed_response_id: turn?.completedResponseId ?? null,
    response_retained: turn?.completedResponseId !== undefined && session.responses.has(turn.completedResponseId),
    // Emitted calls without registered results, not a count of running commands.
    pending_tool_calls: pendingCalls,
    scope: "bridge-http-and-browser-only",
    replay_allowed: false,
  };
}
