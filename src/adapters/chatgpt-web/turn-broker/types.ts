import type { ChatGptTurnEnvironment } from "../environment";
import type { ToolDeliveryLifecycle, ToolDeliveryPhase } from "../tool-delivery-lifecycle";

export interface PendingTurn extends ChatGptTurnEnvironment {
  expiresAt?: number;
}

export interface BrokerToolRequest {
  observationId?: string;
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export interface PendingInvocation {
  observedStarted?: number;
  request: BrokerToolRequest;
  lifecycle: ToolDeliveryLifecycle;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
}

export interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type SafeTurnState = "awaiting_start" | "running" | "completed" | "revoked";

export interface SafeWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface SafeTurnControl {
  state: SafeTurnState;
  surfaceNonce: string;
  launcherSent: boolean;
  connectorStarted: boolean;
  finalAnswer?: string;
  sentWaiters: Set<SafeWaiter<void>>;
  startWaiters: Set<SafeWaiter<void>>;
  completionWaiters: Set<SafeWaiter<string>>;
}

export interface TurnChannel {
  traceId: string;
  threadId?: string;
  externalOwner: boolean;
  environment: PendingTurn;
  bindingId?: string;
  queuedCallIds: string[];
  deliveredCallIds: Set<string>;
  invocations: Map<string, PendingInvocation>;
  waiters: Set<ToolWaiter>;
  compactionRequested: boolean;
  compactionResult?: BrokerToolResult;
  compactionDeliveryCount: number;
  completedToolsCount?: number;
  phaseCheckpoint?: {
    submit: (summary: string) => Promise<void>;
    read: (args: Record<string, unknown>) => Promise<unknown>;
  };
  safe?: SafeTurnControl;
  /** Every MCP request owns a lease from token claim until its handler has settled (claimedAt). */
  activities: Map<string, number>;
  /** Prevents a lost/retried or delayed claim from resurrecting activity after cleanup. */
  completedActivities: Set<string>;
  /** Monotonic across activity start/end so a completed request cannot disappear across a fence. */
  activityRevision: number;
  completionCommitted: boolean;
  completionRevision?: number;
  retirementWaiters: Set<SafeWaiter<void>>;
  claimWaiters: Set<SafeWaiter<void>>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

export interface BrokerRequest {
  observationId?: string;
  id: string;
  method:
    | "claim"
    | "resolve"
    | "release"
    | "invoke"
    | "owner_status"
    | "owner_register"
    | "owner_register_safe"
    | "owner_register_alias"
    | "owner_touch_activity"
    | "owner_update"
    | "owner_safe_sent"
    | "owner_next"
    | "owner_complete"
    | "owner_tool_phase"
    | "owner_completion_fence_begin"
    | "owner_completion_fence_commit"
    | "owner_wait_retirement"
    | "owner_revoke"
    | "owner_safe_wait_start"
    | "owner_safe_wait_completion"
    | "owner_request_compaction"
    | "owner_compaction_delivery_count"
    | "safe_start"
    | "safe_complete"
    | "activity_complete"
    | "submit_compaction_handoff"
    | "submit_phase_checkpoint"
    | "read_phase_checkpoint";
  token?: string;
  previousToken?: string;
  newToken?: string;
  terminal?: boolean;
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  environment?: ChatGptTurnEnvironment;
  ttlMs?: number;
  traceId?: string;
  callId?: string;
  activityId?: string;
  revision?: number;
  lifecyclePhase?: ToolDeliveryPhase;
  lifecycleEvidence?: string;
  toolResult?: BrokerToolResult;
  handoffId?: string;
  summary?: string;
  surfaceNonce?: string;
  finalAnswer?: string;
  contract?: "native" | "safe";
  threadId?: string;
}

export interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

export interface TurnBrokerOwner {
  register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId?: string,
    externalOwner?: boolean,
    handlePrefix?: string,
    predecessorToken?: string,
    threadId?: string,
  ): Promise<string>;
  registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId?: string,
    externalOwner?: boolean,
    predecessorToken?: string,
    threadId?: string,
  ): Promise<string>;
  registerAlias?(oldToken: string, newToken: string): void | Promise<void>;
  touchActivity?(token: string, activityId: string): boolean | Promise<boolean>;
  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void | Promise<void>;
  confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): { confirmed: true; duplicate: boolean } | Promise<{ confirmed: true; duplicate: boolean }>;
  nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]>;
  recordToolLifecyclePhase?(
    token: string,
    callId: string,
    phase: ToolDeliveryPhase,
    evidence?: string,
  ): void | Promise<void>;
  completeTool(token: string, callId: string, result: BrokerToolResult): void | Promise<void>;
  waitForSafeStart(token: string, signal?: AbortSignal): Promise<void>;
  waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string>;
  requestCompaction(token: string, queuedResult: BrokerToolResult): number | Promise<number>;
  compactionDeliveryCount(token: string): number | Promise<number>;
  beginCompletionFence(token: string): number | undefined | Promise<number | undefined>;
  commitCompletionFence(token: string, revision: number): boolean | Promise<boolean>;
  waitForRetirement(token: string, signal?: AbortSignal): Promise<void>;
  waitForClaim?(token: string, signal?: AbortSignal): Promise<void>;
  revoke(token: string, reason?: Error, options?: { terminal?: boolean }): void | Promise<void>;
}
