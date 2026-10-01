import { createHash } from "node:crypto";
import { sessionReconciliationRequiredError } from "../adapter-error";
import { PhaseCheckpointStore } from "../phase-checkpoints";
import { RetainedConversationBindings } from "../retained-conversation-binding";
import { chatGptNativeThreadOwnershipKey } from "../turn-execution/keys";
import { SessionActor } from "./actor";
import type { SessionActorJournal } from "./journal";
import type { SessionResultStore } from "./results";
import type { SessionAcknowledgement, SessionCompactionContinuationSource } from "./types";
import { SESSION_ACTOR_PROTOCOL_VERSION } from "./types";

/** Holds only actor mailboxes; the WAL journal owns session state. */
export class SessionActorManager {
  private readonly actors = new Map<string, SessionActor>();
  private readonly retainedBindings: RetainedConversationBindings;
  readonly phaseCheckpoints?: PhaseCheckpointStore;

  constructor(
    readonly journal: SessionActorJournal,
    private readonly results?: SessionResultStore,
    private readonly surfaceIsGone?: (surfaceId: string) => boolean | Promise<boolean>,
    private readonly releaseSurface?: (surfaceId: string) => Promise<boolean> | boolean,
  ) {
    this.retainedBindings = new RetainedConversationBindings(journal, (sessionId) => this.actor(sessionId));
    if (results)
      this.phaseCheckpoints = new PhaseCheckpointStore(journal, results, (sessionId) => this.actor(sessionId));
  }

  bindRetainedConversation(...args: Parameters<RetainedConversationBindings["bind"]>): Promise<void> {
    return this.retainedBindings.bind(...args);
  }

  retainedConversationBinding(...args: Parameters<RetainedConversationBindings["resolve"]>) {
    return this.retainedBindings.resolve(...args);
  }

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

  resourceDiagnostics(): {
    pending_persistences: number;
    pending_effects: number;
  } {
    let pendingPersistences = 0;
    let pendingEffects = 0;
    for (const actor of this.actors.values()) {
      const diagnostics = actor.resourceDiagnostics();
      pendingPersistences += diagnostics.pendingPersistences;
      pendingEffects += diagnostics.pendingEffects;
    }
    return {
      pending_persistences: pendingPersistences,
      pending_effects: pendingEffects,
    };
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

  /** Missing completion is ambiguous unless the journal positively proves Send was not activated. */
  recoverUncertainOperationsForSession(sessionId: string, currentTurnId?: string, currentOperationId?: string): void {
    for (const operation of this.journal.uncertainOperationsForSession(sessionId)) {
      if (
        currentTurnId &&
        operation.turnId === currentTurnId &&
        (!currentOperationId || operation.operationId === currentOperationId)
      ) {
        continue;
      }
      this.recoverUncertainOperation(operation);
    }
  }

  private recoverUncertainOperation(operation: NonNullable<ReturnType<SessionActorJournal["operation"]>>): void {
    if (!this.results) return;
    const ref = this.results.referenceFor(operation);
    try {
      const result = this.results.get(ref);
      if (
        result.sessionId !== operation.sessionId ||
        result.generation !== operation.generation ||
        result.turnId !== operation.turnId ||
        result.operationId !== operation.operationId
      ) {
        throw new Error("Session actor recovery result ownership mismatch");
      }
      // Tool result files are prepared before delivery; they do not prove its completion.
      if (operation.kind === "browser_send") {
        this.journal.reconcileOperation(
          operation.sessionId,
          operation.generation,
          operation.operationId,
          "completed",
          ref,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.journal.wasOperationNotSent(operation.sessionId, operation.generation, operation.operationId)) {
          this.journal.reconcileOperation(
            operation.sessionId,
            operation.generation,
            operation.operationId,
            "not_sent",
            `prepared:${ref}`,
          );
        }
        return;
      }
      console.error(
        `[session-actor] uncertain op ${operation.operationId} recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private surfaceReconciliationId(surfaceId: string, generation: number): string {
    const digest = createHash("sha256").update(surfaceId).digest("hex");
    return `surface-reconciled:${generation}:${digest}`;
  }

  private async reconcileRevokedSurfaces(sessionId: string): Promise<void> {
    for (const owner of this.journal.revokedSurfaces(sessionId)) {
      let gone = this.surfaceIsGone ? await this.surfaceIsGone(owner.surfaceId) : true;
      if (!gone && this.releaseSurface) {
        try {
          await this.releaseSurface(owner.surfaceId);
        } catch (error) {
          console.warn(
            `[session-actor] failed to release revoked surface ${owner.surfaceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        gone = this.surfaceIsGone ? await this.surfaceIsGone(owner.surfaceId) : true;
      }
      if (!gone) {
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
    const priorSurface = this.journal.surfaceForSession(owner.sessionId, owner.generation);
    if (priorSurface && this.releaseSurface) {
      try {
        await this.releaseSurface(priorSurface);
      } catch (error) {
        console.warn(
          `[session-actor] failed to release surface ${priorSurface} on revocation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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

  /** Startup recovery uses the same evidence rules as recovery of a live session. */
  recoverUncertainOperations(): void {
    for (const operation of this.journal.uncertainOperations()) this.recoverUncertainOperation(operation);
  }

  async recordCompactionContinuationSource(
    sessionId: string,
    nativeTurnId: string,
    operationId: string,
    source: SessionCompactionContinuationSource,
  ): Promise<void> {
    if (!sessionId.endsWith(`:${chatGptNativeThreadOwnershipKey(source.threadId)}`) || !source.sources[0]) {
      throw new Error("Session actor checkpoint source ownership mismatch");
    }
    const admission = await this.beginTurn(sessionId, nativeTurnId);
    if (admission.status !== "accepted") throw new Error("Session actor checkpoint source requires recovery");
    const generation = this.journal.snapshot(sessionId)!.generation;
    const acknowledgement = await this.actor(sessionId).recordLocal(
      "compaction_source_recorded",
      nativeTurnId,
      operationId,
      { continuationSourceJson: JSON.stringify(source) },
      generation,
    );
    if (acknowledgement.status !== "accepted") throw new Error("Session actor checkpoint source requires recovery");
  }

  acceptedCompactionContinuations(
    sessionId: string,
    nativeTurnId: string,
  ): Array<{
    generation: number;
    operationId: string;
    summary: string;
    source: SessionCompactionContinuationSource;
  }> {
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId || !this.results) return [];
    return this.journal.acceptedCompactions(sessionId, snapshot.generation, nativeTurnId).flatMap((checkpoint) => {
      const recorded = this.journal.findLocalTransition(
        sessionId,
        snapshot.generation,
        "compaction_source_recorded",
        checkpoint.operationId,
        nativeTurnId,
      );
      if (!recorded?.command.continuationSourceJson) return [];
      const source = JSON.parse(recorded.command.continuationSourceJson) as SessionCompactionContinuationSource;
      if (
        typeof source.threadId !== "string" ||
        typeof source.modelId !== "string" ||
        (source.reasoning !== undefined && typeof source.reasoning !== "string") ||
        !sessionId.endsWith(`:${chatGptNativeThreadOwnershipKey(source.threadId)}`) ||
        !Array.isArray(source.sources) ||
        !source.sources[0] ||
        source.sources.some((revision) => !revision || !("content" in revision))
      ) {
        throw new Error("Session actor checkpoint source identity mismatch");
      }
      const recovered = this.checkpointRecovery(sessionId, nativeTurnId, checkpoint.operationId);
      if (recovered?.state !== "accepted") return [];
      return [
        { generation: snapshot.generation, operationId: checkpoint.operationId, summary: recovered.summary, source },
      ];
    });
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
      throw sessionReconciliationRequiredError();
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
      onSendActivated: () => Promise<void>,
    ) => Promise<string>,
    onAdmitted?: (generation: number) => void,
  ): Promise<string> {
    if (!this.results) throw new Error("Session actor browser result store is unavailable");
    const current = this.journal.snapshot(sessionId);
    if (current?.turnId === nativeTurnId) {
      const replay = this.journal.operation(sessionId, current.generation, operationId);
      if (replay?.state === "completed" || replay?.state === "uncertain") {
        if (replay.kind !== "browser_send" || replay.turnId !== nativeTurnId) {
          throw new Error("Session actor browser replay ownership mismatch");
        }
        const ref = replay.state === "completed" ? replay.resultRef : this.results.referenceFor(replay);
        if (!ref) throw new Error("Session actor browser replay has no durable result reference");
        let result: ReturnType<SessionResultStore["get"]> | undefined;
        try {
          result = this.results.get(ref);
        } catch (error) {
          if (replay.state === "completed" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (result) {
          if (
            result.sessionId !== sessionId ||
            result.generation !== current.generation ||
            result.turnId !== nativeTurnId ||
            result.operationId !== operationId
          ) {
            throw new Error("Session actor browser replay result ownership mismatch");
          }
          if (replay.state === "uncertain") {
            await this.actor(sessionId).reconcile(operationId, current.generation, "completed", ref);
          }
          const owner = this.journal.snapshot(sessionId);
          if (owner?.generation !== current.generation || owner.turnId !== nativeTurnId) {
            throw new Error("Session actor browser replay ownership changed during reconciliation");
          }
          onAdmitted?.(current.generation);
          return result.text;
        }
      }
    }
    this.recoverUncertainOperationsForSession(sessionId, nativeTurnId, operationId);
    const unresolved = this.journal.uncertainOperationsForSession(sessionId).some((operation) => {
      const retryNotSent =
        operation.kind === "browser_send" &&
        operation.turnId === nativeTurnId &&
        operation.operationId === operationId &&
        this.journal.wasOperationNotSent(sessionId, operation.generation, operationId);
      return !retryNotSent;
    });
    // Reject before recording turn_started: a failed replacement must not steal ownership
    // from the accepted turn whose response still needs reconciliation.
    if (unresolved) throw sessionReconciliationRequiredError();
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
      const ref = this.results.referenceFor(existing);
      if (!this.journal.wasOperationNotSent(sessionId, generation, operationId)) {
        throw sessionReconciliationRequiredError();
      }
      await actor.reconcile(operationId, generation, "not_sent", `prepared:${ref}`);
    }
    if (this.journal.operation(sessionId, generation, operationId)?.state === "abandoned") {
      this.journal.resetAbandonedOperation(sessionId, generation, operationId);
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
      await emit("operation_prepared");
      let activation: Promise<void> | undefined;
      const onSendActivated = (): Promise<void> => {
        activation ??= emit("operation_send_activated");
        return activation;
      };
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
          let priorGone = this.surfaceIsGone ? await this.surfaceIsGone(priorSurface) : true;
          if (!priorGone && this.releaseSurface) {
            try {
              await this.releaseSurface(priorSurface);
            } catch (error) {
              console.warn(
                `[session-actor] failed to release prior surface ${priorSurface}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            priorGone = this.surfaceIsGone ? await this.surfaceIsGone(priorSurface) : true;
          }
          if (!priorGone) {
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
      const text = await run(
        onAccepted,
        onToolBatchObserved,
        onSurfaceLeased,
        onSurfaceReleased,
        onResultReady,
        onSendActivated,
      );
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
