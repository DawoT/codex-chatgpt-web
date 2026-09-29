/**
 * Explicit phase machine for the browser completion loop.
 *
 * The loop this serves used to carry its phases implicitly in sequential async code plus a handful
 * of loose booleans. This type owns the decision table instead: every observation of the response
 * DOM maps to exactly one phase and one action, so the loop only executes actions. Verdicts stay
 * with the DOM health/completion trackers (the guards); the FSM decides *where the turn is* and
 * *what to do next*, which is what makes the loop's logic testable without a page or a clock.
 *
 * The completion fence (the two-phase "may I finish" handshake with the turn broker) is modeled as
 * a sub-state of `settling`; its async calls stay in the loop, which reports the outcomes back via
 * `fenceAccepted` / `fenceBeginUnavailable` / `fenceCommitted`.
 */

export type ChatGptTurnCompletionPhase = "awaiting_response" | "streaming" | "tool_pending" | "settling" | "completed";

export interface ChatGptTurnCompletionObservation {
  /** The bound assistant turn subtree is mounted and readable. */
  responsePresent: boolean;
  /** The completion trackers agreed the turn has finished producing evidence. */
  completionReady: boolean;
  /** MCP tool calls are executing on this turn (external progress). */
  externalToolCallsInFlight: boolean;
  /** Recent MCP activity proves ChatGPT is still executing although the DOM is quiet or hidden. */
  externalProgressLive: boolean;
}

export type ChatGptTurnCompletionAction =
  /** Sleep replaced by a wake: wait for the next DOM mutation or external progress advance. */
  | "wait_for_signal"
  | "fence_begin"
  /** Wait for one fresh DOM read after the fence revision was captured. */
  | "fresh_read"
  | "fence_commit"
  | "finish";

export interface ChatGptTurnCompletionDecision {
  phase: ChatGptTurnCompletionPhase;
  /** The phase before this observation (equals `phase` when nothing changed). */
  from: ChatGptTurnCompletionPhase;
  /** True when this observation moved the turn into a phase it was not in before. */
  changed: boolean;
  action: ChatGptTurnCompletionAction;
}

type ChatGptCompletionFenceStage = "idle" | "begin_in_flight" | "fresh_read_armed" | "commit_in_flight" | "committed";

export class ChatGptTurnCompletionFsm {
  private currentPhase: ChatGptTurnCompletionPhase = "awaiting_response";
  private fenceStage: ChatGptCompletionFenceStage = "idle";
  private readonly fenced: boolean;

  constructor(options: { fenced: boolean }) {
    this.fenced = options.fenced;
  }

  get phase(): ChatGptTurnCompletionPhase {
    return this.currentPhase;
  }

  observe(observation: ChatGptTurnCompletionObservation): ChatGptTurnCompletionDecision {
    if (!observation.responsePresent) {
      // The response subtree is gone (or never mounted). Completion evidence is only meaningful
      // for a readable response, so settle the phase and keep listening; a live external progress
      // pause is the same posture. The fence sub-state is preserved — readiness resumes where it
      // was once the subtree remounts.
      return this.decide("awaiting_response", "wait_for_signal");
    }
    if (!observation.completionReady) {
      // Readiness lapsed (new activity, truncated evidence): the broker fence revision captured
      // earlier no longer describes the DOM projection, so it must be re-acquired from scratch.
      this.fenceStage = "idle";
      const phase = observation.externalToolCallsInFlight ? "tool_pending" : "streaming";
      return this.decide(phase, "wait_for_signal");
    }
    if (!this.fenced) return this.decide("completed", "finish");
    switch (this.fenceStage) {
      case "idle":
        return this.decide("settling", "fence_begin", "begin_in_flight");
      case "begin_in_flight":
        return this.decide("settling", "wait_for_signal");
      case "fresh_read_armed": {
        this.fenceStage = "commit_in_flight";
        return this.decide("settling", "fresh_read");
      }
      case "commit_in_flight":
        return this.decide("settling", "fence_commit");
      case "committed":
        return this.decide("completed", "finish");
    }
  }

  /** `completionFence.begin()` returned a revision; the next read must be fresh before commit. */
  fenceAccepted(): void {
    this.fenceStage = "fresh_read_armed";
  }

  /** `completionFence.begin()` could not grant a revision; the fence stays idle for another try. */
  fenceBeginUnavailable(): void {
    this.fenceStage = "idle";
  }

  /** `completionFence.commit()` decided whether the captured revision may still finish the turn. */
  fenceCommitted(committed: boolean): void {
    this.fenceStage = committed ? "committed" : "idle";
  }

  /** Compaction handoff was accepted by the server/host; the turn transitions to completed. */
  compactionHandoffObserved(): ChatGptTurnCompletionDecision {
    return this.decide("completed", "finish");
  }

  private decide(
    phase: ChatGptTurnCompletionPhase,
    action: ChatGptTurnCompletionAction,
    fenceStage?: ChatGptCompletionFenceStage,
  ): ChatGptTurnCompletionDecision {
    if (fenceStage !== undefined) this.fenceStage = fenceStage;
    const from = this.currentPhase;
    const changed = from !== phase;
    this.currentPhase = phase;
    return { phase, from, changed, action };
  }
}
