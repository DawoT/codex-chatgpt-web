import type { SessionAcknowledgement, SessionCommand } from "./types";
import { SESSION_ACTOR_PROTOCOL_VERSION } from "./types";
import { SessionActorJournal } from "./journal";

export class SessionActor {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly effects = new Map<string, Promise<void>>();

  constructor(
    private readonly journal: SessionActorJournal,
    readonly sessionId: string,
  ) {}

  dispatch(command: SessionCommand): Promise<SessionAcknowledgement> {
    if (command.sessionId !== this.sessionId) {
      return Promise.reject(new Error("Session actor command addressed another session"));
    }
    const result = this.tail.then(() => this.journal.apply(command));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  recordLocal(
    type: SessionCommand["type"],
    turnId: string,
    operationId: string,
    fields: Pick<SessionCommand, "historyRevision" | "parentOperationId" | "toolBatchRevision" | "surfaceId" | "surfaceGeneration" | "checkpointRef"> = {},
    expectedGeneration?: number,
  ): Promise<SessionAcknowledgement> {
    const result = this.tail.then(() => {
      const generation = this.journal.snapshot(this.sessionId)?.generation ?? 1;
      if (expectedGeneration !== undefined && generation !== expectedGeneration) {
        throw new Error("Session actor generation changed before local event confirmation");
      }
      const prior = this.journal.findLocalTransition(this.sessionId, generation, type, operationId);
      if (prior) {
        if (prior.command.turnId !== turnId
          || Object.entries(fields).some(([key, value]) => (
            prior.command[key as keyof SessionCommand] !== value
          ))) {
          throw new Error("Session actor local event duplicate has different contents");
        }
        return prior.acknowledgement;
      }
      return this.journal.apply({
        protocolVersion: SESSION_ACTOR_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        generation,
        turnId,
        operationId,
        producerId: "daemon",
        producerSequence: this.journal.nextProducerSequence(this.sessionId, generation, "daemon"),
        type,
        ...fields,
      });
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  reconcile(
    operationId: string,
    generation: number,
    outcome: "not_sent" | "completed",
    evidenceRef: string,
  ): Promise<number> {
    const result = this.tail.then(() => this.journal.reconcileOperation(
      this.sessionId,
      generation,
      operationId,
      outcome,
      evidenceRef,
    ));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async launch(
    intent: SessionCommand,
    effect: (emit: (
      type: "operation_accepted" | "operation_completed",
      resultRef?: string,
    ) => Promise<void>) => Promise<void>,
  ): Promise<{ acknowledgement: SessionAcknowledgement; settled: Promise<void> }> {
    if (intent.type !== "operation_intent") {
      throw new Error("Session actor can launch only a recorded operation intent");
    }
    const acknowledgement = await this.dispatch(intent);
    const key = `${intent.generation}:${intent.operationId}`;
    const existing = this.effects.get(key);
    if (existing) return { acknowledgement, settled: existing };
    const operation = this.journal.operation(this.sessionId, intent.generation, intent.operationId);
    if (acknowledgement.status === "accepted" && operation?.state === "completed") {
      return { acknowledgement, settled: Promise.resolve() };
    }
    if (acknowledgement.status !== "accepted" || operation?.state !== "intent") {
      throw new Error("Session actor operation requires reconciliation before an external effect");
    }
    let producerSequence = 0;
    const emit = async (
      type: "operation_accepted" | "operation_completed",
      resultRef?: string,
    ): Promise<void> => {
      producerSequence += 1;
      const result = await this.dispatch({
        ...intent,
        type,
        producerId: `effect:${intent.operationId}`,
        producerSequence,
        ...(resultRef ? { resultRef } : {}),
      });
      if (result.status !== "accepted") {
        throw new Error(`Session actor effect result rejected: ${result.status.replaceAll("_", " ")}`);
      }
    };
    const settled = Promise.resolve().then(() => effect(emit)).catch(async error => {
      const pending = this.journal.operation(this.sessionId, intent.generation, intent.operationId);
      if (pending?.state === "intent" || pending?.state === "accepted") {
        await this.dispatch({
          ...intent,
          type: "operation_uncertain",
          producerId: `effect:${intent.operationId}`,
          producerSequence: producerSequence + 1,
        });
      }
      throw error;
    }).finally(() => {
      if (this.effects.get(key) === settled) this.effects.delete(key);
    });
    this.effects.set(key, settled);
    void settled.catch(() => {});
    return { acknowledgement, settled };
  }
}
