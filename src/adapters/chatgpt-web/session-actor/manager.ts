import { SessionActor } from "./actor";
import { SessionActorJournal } from "./journal";
import { SessionResultStore } from "./results";
import type { SessionAcknowledgement } from "./types";
import { SESSION_ACTOR_PROTOCOL_VERSION } from "./types";

/** Holds only actor mailboxes; the WAL journal owns session state. */
export class SessionActorManager {
  private readonly actors = new Map<string, SessionActor>();

  constructor(
    readonly journal: SessionActorJournal,
    private readonly results?: SessionResultStore,
  ) {}

  actor(sessionId: string): SessionActor {
    let actor = this.actors.get(sessionId);
    if (!actor) {
      actor = new SessionActor(this.journal, sessionId);
      this.actors.set(sessionId, actor);
    }
    return actor;
  }

  beginTurn(sessionId: string, nativeTurnId: string): Promise<SessionAcknowledgement> {
    return this.actor(sessionId).recordLocal("turn_started", nativeTurnId, `turn:${nativeTurnId}`);
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
    ) => Promise<string>,
  ): Promise<string> {
    if (!this.results) throw new Error("Session actor browser result store is unavailable");
    const admission = await this.beginTurn(sessionId, nativeTurnId);
    if (admission.status !== "accepted") {
      throw new Error(`Session actor turn requires recovery: ${admission.status}`);
    }
    const snapshot = this.journal.snapshot(sessionId);
    if (!snapshot || snapshot.turnId !== nativeTurnId) {
      throw new Error("Session actor native turn ownership changed before browser work");
    }
    const generation = snapshot.generation;
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
      let recovered: ReturnType<SessionResultStore["get"]>;
      try {
        recovered = this.results.get(ref);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Session actor browser send requires reconciliation before retry");
        }
        throw error;
      }
      await actor.reconcile(operationId, generation, "completed", ref);
      return recovered.text;
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
    const launched = await actor.launch(intent, async emit => {
      let acceptance: Promise<void> | undefined;
      const onAccepted = (): Promise<void> => {
        acceptance ??= emit("operation_accepted");
        return acceptance;
      };
      const onToolBatchObserved = async (
        requestId: number,
        revision: number,
      ): Promise<SessionAcknowledgement> => {
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
        const acknowledgement = await actor.recordLocal(
          "surface_claimed",
          nativeTurnId,
          `surface-claim:${operationId}`,
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
        const acknowledgement = await actor.recordLocal(
          "surface_released",
          nativeTurnId,
          `surface-release:${operationId}`,
          { surfaceId },
          generation,
        );
        if (acknowledgement.status !== "accepted") {
          throw new Error(`Session actor surface release rejected: ${acknowledgement.status}`);
        }
      };
      const text = await run(onAccepted, onToolBatchObserved, onSurfaceLeased, onSurfaceReleased);
      await onAccepted();
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
    if (result.sessionId !== sessionId || result.generation !== generation
      || result.turnId !== nativeTurnId || result.operationId !== operationId) {
      throw new Error("Session actor browser result ownership mismatch");
    }
    return result.text;
  }
}
