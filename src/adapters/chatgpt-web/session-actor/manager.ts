import { createHash } from "node:crypto";
import { chatGptNativeThreadOwnershipKey } from "../turn-execution/keys";
import { SessionActor } from "./actor";
import type { SessionActorJournal } from "./journal";
import type { SessionResultStore } from "./results";
import type { SessionAcknowledgement } from "./types";
import { SESSION_ACTOR_PROTOCOL_VERSION } from "./types";

/** Holds only actor mailboxes; the WAL journal owns session state. */
export class SessionActorManager {
  private readonly actors = new Map<string, SessionActor>();

  constructor(
    readonly journal: SessionActorJournal,
    private readonly results?: SessionResultStore,
    private readonly surfaceIsGone?: (surfaceId: string) => boolean | Promise<boolean>,
  ) {}

  actor(sessionId: string): SessionActor {
    let actor = this.actors.get(sessionId);
    if (!actor) {
      actor = new SessionActor(this.journal, sessionId);
      this.actors.set(sessionId, actor);
    }
    return actor;
  }

  /** True while the manager caches an in-memory mailbox for the session. */
  has(sessionId: string): boolean {
    return this.actors.has(sessionId);
  }

  /**
   * Drop the in-memory mailbox once its queued commands have drained. The WAL
   * journal keeps owning session state, so the next actor(sessionId) rebuilds
   * an equivalent mailbox over the same history. The identity check keeps a
   * mailbox created by a concurrent actor(sessionId) call from being deleted.
   */
  async dispose(sessionId: string): Promise<void> {
    const actor = this.actors.get(sessionId);
    if (!actor) return;
    await actor.quiesce();
    if (this.actors.get(sessionId) === actor) this.actors.delete(sessionId);
  }

  beginTurn(sessionId: string, nativeTurnId: string): Promise<SessionAcknowledgement> {
    this.recoverUncertainOperationsForSession(sessionId, nativeTurnId);
    return this.actor(sessionId).recordLocal("turn_started", nativeTurnId, `turn:${nativeTurnId}`);
  }

  /**
   * Auto-abandon or complete uncertain operations for a specific session at runtime.
   * If an operation has no result on disk (ENOENT), it was never completed and is
   * auto-abandoned so it does not block future turns or effects. If currentTurnId
   * and currentOperationId match, that operation is actively being retried and is skipped.
   */
  recoverUncertainOperationsForSession(sessionId: string, currentTurnId?: string, currentOperationId?: string): void {
    if (!this.results) return;
    const uncertain = this.journal.uncertainOperationsForSession(sessionId);
    for (const op of uncertain) {
      if (
        currentTurnId &&
        op.turnId === currentTurnId &&
        (!currentOperationId || op.operationId === currentOperationId)
      ) {
        continue;
      }
      const ref = this.results.referenceFor({
        sessionId: op.sessionId,
        generation: op.generation,
        turnId: op.turnId,
        operationId: op.operationId,
      });
      let hasResult = false;
      try {
        this.results.get(ref);
        hasResult = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `[session-actor] session ${sessionId} uncertain op ${op.operationId} result check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      try {
        if (hasResult) {
          this.journal.reconcileOperation(op.sessionId, op.generation, op.operationId, "completed", ref);
          console.info(
            `[session-actor] reconciled completed uncertain op ${op.operationId} for session ${op.sessionId}`,
          );
        } else {
          const evidenceRef = `not-sent:${ref}`;
          this.journal.reconcileOperation(op.sessionId, op.generation, op.operationId, "not_sent", evidenceRef);
          console.info(
            `[session-actor] abandoned unrecoverable uncertain op ${op.operationId} for session ${op.sessionId}`,
          );
        }
      } catch (error) {
        console.error(
          `[session-actor] could not reconcile uncertain op ${op.operationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private surfaceReconciliationId(surfaceId: string, generation: number): string {
    const digest = createHash("sha256").update(surfaceId).digest("hex");
    return `surface-reconciled:${generation}:${digest}`;
  }

  private async reconcileRevokedSurfaces(sessionId: string): Promise<void> {
    for (const owner of this.journal.revokedSurfaces(sessionId)) {
      if (!this.surfaceIsGone || !(await this.surfaceIsGone(owner.surfaceId))) {
        throw new Error("Session actor revoked surface is still present and cannot be replaced");
      }
      const acknowledgement = await this.actor(sessionId).recordLocal(
        "surface_reconciled",
        "surface-recovery",
        this.surfaceReconciliationId(owner.surfaceId, owner.generation),
        { surfaceId: owner.surfaceId, surfaceGeneration: owner.generation },
      );
      if (acknowledgement.status !== "accepted") {
        throw new Error(`Session actor revoked surface recovery requires reconciliation: ${acknowledgement.status}`);
      }
    }
  }

  private async revokeOwner(
    owner: { sessionId: string; generation: number; turnId: string },
    operationId: string,
  ): Promise<boolean> {
    let acknowledgement: SessionAcknowledgement;
    try {
      acknowledgement = await this.actor(owner.sessionId).recordLocal(
        "generation_revoked",
        owner.turnId,
        operationId,
        {},
        owner.generation,
      );
    } catch (error) {
      const current = this.journal.snapshot(owner.sessionId);
      if (current?.generation !== owner.generation || current.turnId !== owner.turnId) {
        return false;
      }
      throw error;
    }
    if (acknowledgement.status !== "accepted") {
      throw new Error(`Session actor revocation requires recovery: ${acknowledgement.status}`);
    }
    return true;
  }

  async revokeBrowserTrace(traceId: string): Promise<boolean> {
    const owner = this.journal.activeBrowserOwner(`browser:${traceId}`);
    if (!owner) return false;
    return this.revokeOwner(owner, `revoke:${traceId}`);
  }

  async revokeAdmittedTurn(sessionId: string, nativeTurnId: string, traceId: string): Promise<boolean> {
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) return false;
    return this.revokeOwner({ sessionId, generation: snapshot.generation, turnId: nativeTurnId }, `revoke:${traceId}`);
  }

  async revokeNativeTurn(threadId: string, nativeTurnId: string): Promise<number> {
    const owners = this.journal.nativeTurnOwners(chatGptNativeThreadOwnershipKey(threadId), nativeTurnId);
    let revoked = 0;
    for (const owner of owners) {
      if (await this.revokeOwner(owner, `revoke-native:${nativeTurnId}`)) revoked += 1;
    }
    return revoked;
  }

  async revokeAllCurrentTurns(): Promise<number> {
    const owners = this.journal.currentTurnOwners();
    let revoked = 0;
    for (const owner of owners) {
      if (await this.revokeOwner(owner, `revoke-all:${owner.generation}`)) {
        revoked += 1;
        // Global cancellation ends these sessions; evict their mailboxes once
        // quiet so the in-memory map cannot grow with every cancelled session.
        void this.dispose(owner.sessionId);
      }
    }
    return revoked;
  }

  /**
   * Called once during server startup after the journal has run recoverInterrupted().
   * For each uncertain browser_send operation that has no result file (i.e. the browser
   * never completed the send before the server was killed), the operation is immediately
   * abandoned so it no longer blocks future operation_intent commands.
   */
  recoverUncertainOperations(): void {
    if (!this.results) return;
    const uncertain = this.journal.uncertainOperations();
    for (const op of uncertain) {
      const ref = this.results.referenceFor({
        sessionId: op.sessionId,
        generation: op.generation,
        turnId: op.turnId,
        operationId: op.operationId,
      });
      let hasResult = false;
      try {
        this.results.get(ref);
        hasResult = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `[session-actor] uncertain op ${op.operationId} result check failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
      }
      if (hasResult) {
        // Result exists — will be auto-reconciled as completed when the next turn starts.
        continue;
      }
      // No result file: the browser never sent. Mark as abandoned so new turns can proceed.
      try {
        // Use a stable synthetic evidence ref that fits within the 256-char limit.
        const evidenceRef = `not-sent:${ref}`;
        this.journal.reconcileOperation(op.sessionId, op.generation, op.operationId, "not_sent", evidenceRef);
        console.info(
          `[session-actor] abandoned unrecoverable uncertain op ${op.operationId} for session ${op.sessionId}`,
        );
      } catch (error) {
        console.error(
          `[session-actor] could not abandon uncertain op ${op.operationId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  checkpointRecovery(
    sessionId: string,
    nativeTurnId: string,
    operationId: string,
  ):
    | { state: "accepted"; summary: string }
    | { state: "prepared" | "received" | "validated" | "persisted" | "rejected" }
    | null {
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot) return null;
    const checkpoint = this.journal.compaction(sessionId, snapshot.generation, operationId);
    if (!checkpoint) return null;
    if (checkpoint.turnId !== nativeTurnId) {
      throw new Error("Session actor checkpoint recovery belongs to another turn");
    }
    if (checkpoint.state !== "accepted") return { state: checkpoint.state };
    if (!checkpoint.checkpointRef || !this.results) {
      throw new Error("Session actor accepted checkpoint has no durable result");
    }
    const recovered = this.results.get(checkpoint.checkpointRef);
    if (
      recovered.sessionId !== sessionId ||
      recovered.generation !== snapshot.generation ||
      recovered.turnId !== nativeTurnId ||
      recovered.operationId !== `checkpoint:${operationId}`
    ) {
      throw new Error("Session actor checkpoint recovery identity mismatch");
    }
    return { state: "accepted", summary: recovered.text };
  }

  async compactionTransition(
    sessionId: string,
    nativeTurnId: string,
    operationId: string,
    phase:
      | "compaction_prepared"
      | "compaction_received"
      | "compaction_validated"
      | "compaction_persisted"
      | "compaction_accepted"
      | "compaction_rejected",
    summary?: string,
  ): Promise<SessionAcknowledgement> {
    if (!this.results) throw new Error("Session actor checkpoint result store is unavailable");
    if (phase === "compaction_prepared") {
      const admission = await this.beginTurn(sessionId, nativeTurnId);
      if (admission.status !== "accepted") return admission;
    }
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor checkpoint turn ownership changed");
    }
    let checkpointRef: string | undefined;
    if (phase === "compaction_received") {
      if (summary === undefined) throw new Error("Session actor checkpoint summary is required");
      checkpointRef = this.results.put({
        sessionId,
        generation: snapshot.generation,
        turnId: nativeTurnId,
        operationId: `checkpoint:${operationId}`,
        text: summary,
      });
    }
    return this.actor(sessionId).recordLocal(
      phase,
      nativeTurnId,
      operationId,
      checkpointRef ? { checkpointRef } : {},
      snapshot.generation,
    );
  }

  async deliverToolResult(
    sessionId: string,
    nativeTurnId: string,
    browserOperationId: string,
    callId: string,
    result: string,
    deliver: () => void | Promise<void>,
    expectedGeneration?: number,
  ): Promise<void> {
    if (!this.results) throw new Error("Session actor tool result store is unavailable");
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor tool result turn ownership changed");
    }
    if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) {
      throw new Error("Session actor tool result generation changed before delivery");
    }
    const operationId = `tool-result:${callId}`;
    const existing = this.journal.operation(sessionId, snapshot.generation, operationId);
    if (existing?.state === "uncertain") {
      throw new Error("Session actor tool result delivery requires reconciliation before retry");
    }
    if (existing?.state === "completed") {
      if (existing.turnId !== nativeTurnId || !existing.resultRef) {
        throw new Error("Session actor completed tool result has conflicting identity");
      }
      const completed = this.results.get(existing.resultRef);
      if (
        completed.sessionId !== sessionId ||
        completed.generation !== snapshot.generation ||
        completed.turnId !== nativeTurnId ||
        completed.operationId !== operationId ||
        completed.text !== result
      ) {
        throw new Error("Session actor completed tool result has conflicting identity");
      }
      return;
    }
    const emitted = this.journal.findLocalTransition(
      sessionId,
      snapshot.generation,
      "tool_call_emitted",
      `tool-call:${callId}`,
      nativeTurnId,
    );
    const browser = this.journal.operation(sessionId, snapshot.generation, browserOperationId);
    if (
      !emitted ||
      emitted.command.parentOperationId !== browserOperationId ||
      emitted.command.turnId !== nativeTurnId ||
      emitted.command.historyRevision !== snapshot.historyRevision ||
      browser?.kind !== "browser_send" ||
      browser.turnId !== nativeTurnId ||
      browser.historyRevision !== snapshot.historyRevision ||
      browser.state !== "accepted"
    ) {
      throw new Error("Session actor tool result requires an emitted call on the accepted browser turn");
    }
    const resultRef = this.results.put({
      sessionId,
      generation: snapshot.generation,
      turnId: nativeTurnId,
      operationId,
      text: result,
    });
    const actor = this.actor(sessionId);
    const launched = await actor.launch(
      {
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId,
        generation: snapshot.generation,
        turnId: nativeTurnId,
        operationId,
        producerId: `operation:${operationId}`,
        producerSequence: 1,
        type: "operation_intent",
        operationKind: "tool_result_delivery",
        parentOperationId: browserOperationId,
        historyRevision: snapshot.historyRevision,
      },
      async (emit) => {
        await emit("operation_accepted");
        await deliver();
        await emit("operation_completed", resultRef);
      },
    );
    await launched.settled;
    const completed = this.journal.operation(sessionId, snapshot.generation, operationId);
    if (completed?.state !== "completed" || completed.resultRef !== resultRef) {
      throw new Error("Session actor tool result delivery was not durably completed");
    }
  }

  async recordToolCallEmission(
    sessionId: string,
    nativeTurnId: string,
    browserOperationId: string,
    callId: string,
    toolBatchRevision: number,
    expectedGeneration?: number,
  ): Promise<SessionAcknowledgement> {
    return this.recordToolCallTransition(
      "tool_call_emitted",
      sessionId,
      nativeTurnId,
      browserOperationId,
      callId,
      toolBatchRevision,
      expectedGeneration,
    );
  }

  async recordToolCallPreparation(
    sessionId: string,
    nativeTurnId: string,
    browserOperationId: string,
    callId: string,
    toolBatchRevision: number,
    expectedGeneration?: number,
  ): Promise<SessionAcknowledgement> {
    return this.recordToolCallTransition(
      "tool_call_prepared",
      sessionId,
      nativeTurnId,
      browserOperationId,
      callId,
      toolBatchRevision,
      expectedGeneration,
    );
  }

  private async recordToolCallTransition(
    phase: "tool_call_prepared" | "tool_call_emitted",
    sessionId: string,
    nativeTurnId: string,
    browserOperationId: string,
    callId: string,
    toolBatchRevision: number,
    expectedGeneration?: number,
  ): Promise<SessionAcknowledgement> {
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor tool call turn ownership changed");
    }
    if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) {
      throw new Error("Session actor tool call generation changed before confirmation");
    }
    return this.actor(sessionId).recordLocal(
      phase,
      nativeTurnId,
      `tool-call:${callId}`,
      {
        parentOperationId: browserOperationId,
        historyRevision: snapshot.historyRevision,
        toolBatchRevision,
      },
      snapshot.generation,
    );
  }

  async recordToolBatchConfirmed(
    sessionId: string,
    nativeTurnId: string,
    browserOperationId: string,
    toolBatchRevision: number,
    expectedGeneration?: number,
  ): Promise<SessionAcknowledgement> {
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor tool batch turn ownership changed");
    }
    if (expectedGeneration !== undefined && snapshot.generation !== expectedGeneration) {
      throw new Error("Session actor tool batch generation changed before confirmation");
    }
    return this.actor(sessionId).recordLocal(
      "tool_batch_observed",
      nativeTurnId,
      `batch-confirmed:${browserOperationId}:${toolBatchRevision}`,
      {
        parentOperationId: browserOperationId,
        historyRevision: snapshot.historyRevision,
        toolBatchRevision,
      },
      snapshot.generation,
    );
  }

  async runBrowserTurn(
    sessionId: string,
    nativeTurnId: string,
    operationId: string,
    run: (
      onAccepted: () => Promise<void>,
      onToolBatchObserved: (requestId: number, revision: number) => Promise<SessionAcknowledgement>,
      onSurfaceLeased: (surfaceId: string) => Promise<void>,
      onSurfaceReleased: (surfaceId: string) => Promise<void>,
      onResultReady: (text: string) => Promise<void>,
    ) => Promise<string>,
    onAdmitted?: (generation: number) => void,
  ): Promise<string> {
    if (!this.results) throw new Error("Session actor browser result store is unavailable");
    this.recoverUncertainOperationsForSession(sessionId, nativeTurnId, operationId);
    await this.reconcileRevokedSurfaces(sessionId);
    const admission = await this.beginTurn(sessionId, nativeTurnId);
    if (admission.status !== "accepted") {
      throw new Error(`Session actor turn requires recovery: ${admission.status}`);
    }
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor native turn ownership changed before browser work");
    }
    const generation = snapshot.generation;
    onAdmitted?.(generation);
    const actor = this.actor(sessionId);
    const existing = this.journal.operation(sessionId, generation, operationId);
    if (existing?.state === "uncertain") {
      if (existing.turnId !== nativeTurnId) {
        throw new Error("Session actor uncertain operation belongs to another turn");
      }
      const ref = this.results.referenceFor({
        sessionId,
        generation,
        turnId: nativeTurnId,
        operationId,
      });
      let recovered: ReturnType<SessionResultStore["get"]> | undefined;
      try {
        recovered = this.results.get(ref);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (recovered) {
        await actor.reconcile(operationId, generation, "completed", ref);
        return recovered.text;
      }
      if (this.journal.wasOperationAccepted(sessionId, generation, operationId)) {
        throw new Error("Session actor browser send requires reconciliation before retry");
      }
    }
    const intent = {
      protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
      sessionId,
      generation,
      turnId: nativeTurnId,
      operationId,
      producerId: `operation:${operationId}`,
      producerSequence: 1,
      type: "operation_intent" as const,
      operationKind: "browser_send",
      historyRevision: snapshot.historyRevision,
    };
    const launched = await actor.launch(intent, async (emit) => {
      let acceptance: Promise<void> | undefined;
      const onAccepted = (): Promise<void> => {
        acceptance ??= emit("operation_accepted");
        return acceptance;
      };
      const onToolBatchObserved = async (requestId: number, revision: number): Promise<SessionAcknowledgement> => {
        if (!Number.isSafeInteger(requestId) || requestId < 1) {
          throw new Error("Session actor tool batch request id is invalid");
        }
        await onAccepted();
        const acknowledgement = await actor.recordLocal(
          "tool_batch_observed",
          nativeTurnId,
          `batch:${operationId}:${requestId}`,
          {
            parentOperationId: operationId,
            historyRevision: snapshot.historyRevision,
            toolBatchRevision: revision,
          },
          generation,
        );
        if (acknowledgement.status !== "accepted") {
          throw new Error(`Session actor tool batch observation rejected: ${acknowledgement.status}`);
        }
        return acknowledgement;
      };
      let leasedSurfaceId: string | undefined;
      const onSurfaceLeased = async (surfaceId: string): Promise<void> => {
        if (leasedSurfaceId && leasedSurfaceId !== surfaceId) {
          throw new Error("Session actor browser operation changed leased surface");
        }
        const priorSurface = this.journal.surfaceForSession(sessionId, generation);
        if (priorSurface && priorSurface !== surfaceId) {
          if (!this.surfaceIsGone || !(await this.surfaceIsGone(priorSurface))) {
            throw new Error("Session actor retained surface still owns this session");
          }
          const release = await actor.recordLocal(
            "surface_released",
            nativeTurnId,
            `surface-reconciled:${operationId}:${priorSurface}`,
            { surfaceId: priorSurface },
            generation,
          );
          if (release.status !== "accepted") {
            throw new Error(`Session actor prior surface release rejected: ${release.status}`);
          }
        }
        const acknowledgement = await actor.recordLocal(
          "surface_claimed",
          nativeTurnId,
          `surface-claim:${operationId}:${surfaceId}`,
          { surfaceId },
          generation,
        );
        if (acknowledgement.status !== "accepted") {
          throw new Error(`Session actor surface claim rejected: ${acknowledgement.status}`);
        }
        leasedSurfaceId = surfaceId;
      };
      const onSurfaceReleased = async (surfaceId: string): Promise<void> => {
        if (leasedSurfaceId !== surfaceId) {
          throw new Error("Session actor browser operation released an unclaimed surface");
        }
        try {
          const acknowledgement = await actor.recordLocal(
            "surface_released",
            nativeTurnId,
            `surface-release:${operationId}:${surfaceId}`,
            { surfaceId },
            generation,
          );
          if (acknowledgement.status !== "accepted") {
            throw new Error(`Session actor surface release rejected: ${acknowledgement.status}`);
          }
        } catch (error) {
          const current = this.journal.snapshot(sessionId);
          if (!current || current.generation <= generation) throw error;
          const reconciled = await actor.recordLocal(
            "surface_reconciled",
            "surface-recovery",
            this.surfaceReconciliationId(surfaceId, generation),
            { surfaceId, surfaceGeneration: generation },
          );
          if (reconciled.status !== "accepted") {
            throw new Error(`Session actor revoked surface reconciliation rejected: ${reconciled.status}`);
          }
        }
      };
      const assertResultOwner = (): void => {
        const current = this.journal.snapshot(sessionId);
        const operation = this.journal.operation(sessionId, generation, operationId);
        if (
          current?.generation !== generation ||
          current.turnId !== nativeTurnId ||
          operation?.kind !== "browser_send" ||
          operation.state !== "accepted"
        ) {
          throw new Error("Session actor browser result generation or operation changed before persistence");
        }
      };
      const onResultReady = async (text: string): Promise<void> => {
        await onAccepted();
        assertResultOwner();
        this.results!.put({
          sessionId,
          generation,
          turnId: nativeTurnId,
          operationId,
          text,
        });
      };
      const text = await run(onAccepted, onToolBatchObserved, onSurfaceLeased, onSurfaceReleased, onResultReady);
      await onAccepted();
      assertResultOwner();
      const resultRef = this.results!.put({
        sessionId,
        generation,
        turnId: nativeTurnId,
        operationId,
        text,
      });
      await emit("operation_completed", resultRef);
    });
    await launched.settled;
    const operation = this.journal.operation(sessionId, generation, operationId);
    if (operation?.state !== "completed" || !operation.resultRef) {
      throw new Error("Session actor browser result was not durably completed");
    }
    const result = this.results.get(operation.resultRef);
    if (
      result.sessionId !== sessionId ||
      result.generation !== generation ||
      result.turnId !== nativeTurnId ||
      result.operationId !== operationId
    ) {
      throw new Error("Session actor browser result ownership mismatch");
    }
    return result.text;
  }
}
