export const SESSION_ACTOR_PROTOCOL_VERSION = 3;

export type SessionEventType =
  | "turn_started"
  | "operation_intent"
  | "operation_accepted"
  | "operation_completed"
  | "operation_uncertain"
  | "surface_claimed"
  | "surface_released"
  | "compaction_prepared"
  | "compaction_received"
  | "compaction_validated"
  | "compaction_persisted"
  | "compaction_accepted"
  | "compaction_rejected"
  | "generation_revoked";

export interface SessionCommand {
  protocolVersion: number;
  sessionId: string;
  generation: number;
  turnId: string;
  operationId: string;
  producerId: string;
  producerSequence: number;
  type: SessionEventType;
  operationKind?: string;
  historyRevision?: number;
  surfaceId?: string;
  resultRef?: string;
  checkpointRef?: string;
}

export type SessionAcknowledgement =
  | { status: "accepted"; sequence: number }
  | { status: "recovery_required"; expectedProducerSequence: number }
  | { status: "stale_generation"; currentGeneration: number };
