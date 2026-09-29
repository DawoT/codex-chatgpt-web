export const SESSION_ACTOR_PROTOCOL_VERSION = 4;

export type SessionEventType =
  | "turn_started"
  | "operation_intent"
  | "operation_accepted"
  | "operation_completed"
  | "operation_uncertain"
  | "tool_batch_observed"
  | "tool_call_prepared"
  | "tool_call_emitted"
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
  parentOperationId?: string;
  toolBatchRevision?: number;
}

export type SessionAcknowledgement =
  | { status: "accepted"; sequence: number }
  | { status: "recovery_required"; expectedProducerSequence: number }
  | { status: "stale_generation"; currentGeneration: number };
