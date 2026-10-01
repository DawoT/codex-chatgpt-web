import type { SessionActorManager } from "../session-actor";

/** Coordinates existing actor transitions and persistence; the journal owns recovery and idempotency. */
export class CompactionCheckpointTransaction {
  constructor(
    private readonly manager: SessionActorManager | undefined,
    private readonly sessionId: string,
    private readonly turnId: string | undefined,
    private readonly operationId: string,
  ) {}

  recovery(): ReturnType<SessionActorManager["checkpointRecovery"]> {
    return this.manager && this.turnId
      ? this.manager.checkpointRecovery(this.sessionId, this.turnId, this.operationId)
      : null;
  }

  async transition(phase: Parameters<SessionActorManager["compactionTransition"]>[3], summary?: string): Promise<void> {
    if (!this.manager) return;
    if (!this.turnId) throw new Error("Structured checkpoint requires native turn ownership");
    const acknowledgement = await this.manager.compactionTransition(
      this.sessionId,
      this.turnId,
      this.operationId,
      phase,
      summary,
    );
    if (acknowledgement.status !== "accepted") {
      throw new Error(`Checkpoint actor requires recovery: ${acknowledgement.status}`);
    }
  }

  async receiveAndValidate(summary: string): Promise<void> {
    await this.transition("compaction_received", summary);
    await this.transition("compaction_validated");
  }

  async persist(
    effect: () => boolean,
    onLocalPersist?: (persisted: boolean) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) throw new DOMException("Checkpoint persistence aborted", "AbortError");
    const persisted = effect();
    onLocalPersist?.(persisted);
    await this.transition("compaction_persisted");
    // A completed local write remains journaled for reconciliation after cancellation.
    if (signal?.aborted) throw new DOMException("Checkpoint persistence aborted", "AbortError");
    return persisted;
  }

  async rejectIfOpen(): Promise<void> {
    const current = this.recovery();
    if (current?.state === "persisted" || current?.state === "accepted") return;
    await this.transition("compaction_rejected");
  }
}
