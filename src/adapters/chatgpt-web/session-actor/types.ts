import type { ChatGptTurnUserRevision } from "../environment/types";

/** Wire and storage shapes shared by session actors, the journal and their callers. */
export const SESSION_ACTOR_PROTOCOL_VERSION = 5;

export type SessionEventType =
  | "turn_started"
  | "operation_intent"
  | "operation_prepared"
  | "operation_send_activated"
  | "operation_accepted"
  | "operation_completed"
  | "operation_uncertain"
  | "tool_batch_observed"
  | "tool_call_prepared"
  | "tool_call_emitted"
  | "surface_claimed"
  | "surface_released"
  | "surface_reconciled"
  | "compaction_source_recorded"
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
  surfaceGeneration?: number;
  resultRef?: string;
  checkpointRef?: string;
  continuationSourceJson?: string;
  parentOperationId?: string;
  toolBatchRevision?: number;
}

export type SessionAcknowledgement =
  | { status: "accepted"; sequence: number }
  | { status: "recovery_required"; expectedProducerSequence: number }
  | { status: "stale_generation"; currentGeneration: number };

/** Authored source evidence stored in the existing journal, before checkpoint execution. */
export interface SessionCompactionContinuationSource {
  threadId: string;
  modelId: string;
  reasoning?: string;
  sources: ChatGptTurnUserRevision[];
}
