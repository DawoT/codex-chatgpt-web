import { createHash } from "node:crypto";
import {
  attachDiagnosticError,
  type DiagnosticErrorV1,
  deserializeDiagnosticError,
  parseDiagnosticError,
  serializeDiagnosticError,
} from "../../diagnostics/errors";
import type { RuntimeIdentity } from "../../runtime-identity";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptWebCapabilities } from "./model";
import type { CompiledChatGptWebPrompt } from "./prompt";
import { type ChatGptLunaCheckpoint, parseChatGptLunaCheckpoint } from "./rolling-checkpoint";
import type { ChatGptExternalTurnProgressSnapshot } from "./turn-progress";

export interface ChatGptContextHealth {
  observedDomChars: number;
  estimatedTokens: number;
  compactionRequired: boolean;
  recoveryRequired: boolean;
}

export interface RunMessage {
  type: "run";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
    browserDiagnosticsPath?: string;
    turnTimeoutMs?: number;
    autoApproveToolCalls: boolean;
    useSavedChats?: boolean;
  };
  turn: {
    traceId: string;
    modelId: string;
    reasoning?: string;
    modelFamily?: "5.6" | "6";
    capabilities: ChatGptWebCapabilities;
    nativeConnector?: boolean;
    resumeAvailable?: boolean;
    retainConversation?: boolean;
    requireRetainedConversation?: boolean;
    conversationKey?: string;
    compaction?: boolean;
    pendingMissionRequirements?: boolean;
    captureLunaCheckpoint?: boolean;
    externalProgress?: boolean;
    surfaceOwnership?: boolean;
    resultPersistence?: boolean;
  };
}

export interface VerifyMessage {
  type: "verify";
  id: string;
  config: {
    appName: string;
    browserHostDescriptorPath: string;
  };
}

export interface InspectMessage {
  type: "inspect";
  id: string;
  config: VerifyMessage["config"];
  detectCapabilities: boolean;
}

export interface SmokeMessage {
  type: "smoke";
  id: string;
  config: VerifyMessage["config"];
}

export interface LimitsMessage {
  type: "limits";
  id: string;
  config: VerifyMessage["config"];
}

export type MaintenanceMessage = VerifyMessage | InspectMessage | SmokeMessage | LimitsMessage;
export type InputMessage =
  | RunMessage
  | MaintenanceMessage
  | { type: "prepared_selected_ack"; id: string; prepared: CompiledChatGptWebPrompt }
  | { type: "send_activation_ack"; id: string }
  | { type: "surface_ownership_ack"; id: string; phase: "leased" | "released"; surfaceId: string; accepted: boolean }
  | { type: "result_ready_ack"; id: string; textSha256: string; accepted: boolean }
  | { type: "tool_batch_observed_ack"; id: string; requestId: number; revision: number; accepted: boolean }
  | { type: "completion_fence_begin_ack"; id: string; requestId: number; revision: number | null }
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
  | { type: "abort"; id: string; reason?: "compaction_handoff_accepted"; diagnostic?: DiagnosticErrorV1 }
  | { type: "release_context_pressure"; conversationKey: string }
  | { type: "shutdown" };

export type HelperMessage =
  | { type: "event"; id: string; event: "context_health"; health: ChatGptContextHealth }
  | { type: "ready"; features?: string[]; protocolVersion?: number; identity?: RuntimeIdentity }
  | {
      type: "event";
      id: string;
      event: "heartbeat" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text";
      text?: string;
      continuation?: boolean;
    }
  | { type: "event"; id: string; event: "tool_batch_observed"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "surface_ownership"; phase: "leased" | "released"; surfaceId: string }
  | { type: "event"; id: string; event: "result_ready"; text: string; textSha256: string }
  | { type: "event"; id: string; event: "multipart_stage_acknowledged"; stageIndex: number }
  | { type: "event"; id: string; event: "completion_fence_begin"; requestId: number }
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
  | { type: "event"; id: string; event: "luna_checkpoint"; checkpoint: ChatGptLunaCheckpoint; answerHash: string }
  | { type: "result"; id: string; text: string }
  | {
      type: "error";
      id: string;
      name?: string;
      message: string;
      status?: number;
      errorType?: string;
      code?: string;
      retryable?: boolean;
      diagnostic?: DiagnosticErrorV1;
    };

export function parseHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") {
    const features = message.features;
    if (
      features !== undefined &&
      (!Array.isArray(features) || features.some((feature) => typeof feature !== "string"))
    ) {
      throw new Error("Launcher browser helper advertised invalid features");
    }
    if (
      message.protocolVersion !== undefined &&
      (!Number.isSafeInteger(message.protocolVersion) || (message.protocolVersion as number) < 1)
    ) {
      throw new Error("Launcher browser helper protocol version is invalid");
    }
    let identity: RuntimeIdentity | undefined;
    if (message.identity !== undefined) {
      const value = message.identity as Record<string, unknown>;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.protocolVersion !== message.protocolVersion ||
        typeof value.generation !== "string" ||
        !/^[a-f0-9-]{36}$/.test(value.generation) ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        (value.buildCommit !== null &&
          (typeof value.buildCommit !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.buildCommit))) ||
        (value.artifactSha256 !== null &&
          (typeof value.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactSha256)))
      ) {
        throw new Error("Launcher browser helper identity is invalid");
      }
      if (
        (value.artifactSetSha256 !== undefined &&
          value.artifactSetSha256 !== null &&
          (typeof value.artifactSetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.artifactSetSha256))) ||
        (value.artifactVerification !== undefined &&
          (typeof value.artifactVerification !== "string" ||
            !["paired_manifest_verified", "entrypoint_only", "manifest_mismatch", "unavailable"].includes(
              value.artifactVerification,
            ))) ||
        (value.artifactVerification === "paired_manifest_verified" && typeof value.artifactSetSha256 !== "string")
      )
        throw new Error("Launcher browser helper artifact pairing identity is invalid");
      identity = {
        protocolVersion: message.protocolVersion as number,
        generation: value.generation,
        pid: value.pid as number,
        buildCommit: value.buildCommit,
        artifactSha256: value.artifactSha256,
        ...(value.artifactSetSha256 === undefined ? {} : { artifactSetSha256: value.artifactSetSha256 }),
        ...(value.artifactVerification === undefined
          ? {}
          : { artifactVerification: value.artifactVerification as RuntimeIdentity["artifactVerification"] }),
      };
    }
    return {
      type: "ready",
      ...(features ? { features: features as string[] } : {}),
      ...(message.protocolVersion !== undefined ? { protocolVersion: message.protocolVersion as number } : {}),
      ...(identity ? { identity } : {}),
    };
  }
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    if (event === "context_health") {
      const health = message.health as Record<string, unknown> | undefined;
      if (
        !health ||
        typeof health !== "object" ||
        Array.isArray(health) ||
        !Number.isFinite(health.observedDomChars) ||
        (health.observedDomChars as number) < 0 ||
        !Number.isFinite(health.estimatedTokens) ||
        (health.estimatedTokens as number) < 0 ||
        typeof health.compactionRequired !== "boolean" ||
        typeof health.recoveryRequired !== "boolean"
      ) {
        throw new Error("Launcher browser helper context health is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        health: {
          observedDomChars: health.observedDomChars as number,
          estimatedTokens: health.estimatedTokens as number,
          compactionRequired: health.compactionRequired,
          recoveryRequired: health.recoveryRequired,
        },
      };
    }
    if (event === "multipart_stage_acknowledged") {
      if (!Number.isSafeInteger(message.stageIndex) || (message.stageIndex as number) <= 0) {
        throw new Error("Launcher browser helper multipart stage index is invalid");
      }
      return { type: "event", id: message.id, event, stageIndex: message.stageIndex as number };
    }
    if (event === "tool_batch_observed") {
      if (
        !Number.isSafeInteger(message.revision) ||
        (message.revision as number) <= 0 ||
        !Number.isSafeInteger(message.requestId) ||
        (message.requestId as number) <= 0
      ) {
        throw new Error("Launcher browser helper tool-boundary operation is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
      };
    }
    if (event === "surface_ownership") {
      if (
        (message.phase !== "leased" && message.phase !== "released") ||
        typeof message.surfaceId !== "string" ||
        !/^[A-Za-z0-9_-]{32}$/.test(message.surfaceId)
      ) {
        throw new Error("Launcher browser helper surface ownership event is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        phase: message.phase,
        surfaceId: message.surfaceId,
      };
    }
    if (event === "result_ready") {
      if (
        typeof message.text !== "string" ||
        typeof message.textSha256 !== "string" ||
        createHash("sha256").update(message.text).digest("hex") !== message.textSha256
      ) {
        throw new Error("Launcher browser helper result persistence event is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        text: message.text,
        textSha256: message.textSha256,
      };
    }
    if (event === "completion_fence_begin") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper completion fence request id is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number };
    }
    if (event === "completion_fence_commit") {
      if (
        !Number.isSafeInteger(message.requestId) ||
        (message.requestId as number) <= 0 ||
        !Number.isSafeInteger(message.revision) ||
        (message.revision as number) < 0
      ) {
        throw new Error("Launcher browser helper completion fence revision is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        requestId: message.requestId as number,
        revision: message.revision as number,
      };
    }
    if (event === "luna_checkpoint") {
      if (typeof message.answerHash !== "string" || !/^[a-f0-9]{64}$/.test(message.answerHash)) {
        throw new Error("Launcher browser helper Luna checkpoint answer hash is invalid");
      }
      return {
        type: "event",
        id: message.id,
        event,
        checkpoint: parseChatGptLunaCheckpoint(message.checkpoint),
        answerHash: message.answerHash,
      };
    }
    const text = message.text;
    const continuation = message.continuation;
    if (event === "prepared_selected") {
      if (typeof message.reused !== "boolean") {
        throw new Error("Launcher browser helper prompt selection is invalid");
      }
      return { type: "event", id: message.id, event, reused: message.reused };
    }
    if (!["heartbeat", "send_activated", "submitted", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "send_activated" | "submitted" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const status = message.status;
    const errorType = message.errorType;
    const code = message.code;
    const retryable = message.retryable;
    const structured = status !== undefined || errorType !== undefined || code !== undefined || retryable !== undefined;
    if (
      typeof errorMessage !== "string" ||
      (errorName !== undefined && typeof errorName !== "string") ||
      (structured &&
        (!Number.isInteger(status) ||
          (status as number) < 400 ||
          (status as number) > 599 ||
          typeof errorType !== "string" ||
          !errorType ||
          typeof code !== "string" ||
          !code ||
          typeof retryable !== "boolean"))
    ) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(message.diagnostic === undefined ? {} : { diagnostic: parseDiagnosticError(message.diagnostic) }),
      ...(errorName !== undefined ? { name: errorName as string } : {}),
      ...(structured
        ? {
            status: status as number,
            errorType: errorType as string,
            code: code as string,
            retryable: retryable as boolean,
          }
        : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

/** Maintenance responses share the framing but carry a structured value. */
export type HelperOutputMessage = HelperMessage | { type: "result"; id: string; value: unknown };

export class HelperInputProtocolError extends Error {
  readonly code = "helper_protocol_failure";
  constructor(
    message: string,
    readonly id = "protocol",
    readonly abortTurn = false,
  ) {
    super(message);
    this.name = "HelperInputProtocolError";
  }
}

/** Prompt and progress evidence is validated by the handler that owns that evidence. */
export function parseHelperInputMessage(line: string): InputMessage {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HelperInputProtocolError("Browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  const id = typeof message.id === "string" && message.id ? message.id : "unknown";
  const fail = (detail: string, abortTurn = false): never => {
    throw new HelperInputProtocolError(detail, id, abortTurn);
  };
  if (message.type === "shutdown") return { type: "shutdown" };
  if (message.type === "release_context_pressure") {
    if (typeof message.conversationKey !== "string" || !/^[a-f0-9]{64}$/.test(message.conversationKey)) {
      fail("Browser helper conversation key is invalid");
    }
    return message as InputMessage;
  }
  if (
    ![
      "run",
      "verify",
      "inspect",
      "smoke",
      "limits",
      "prepared_selected_ack",
      "send_activation_ack",
      "surface_ownership_ack",
      "result_ready_ack",
      "tool_batch_observed_ack",
      "completion_fence_begin_ack",
      "completion_fence_commit_ack",
      "progress",
      "abort",
    ].includes(String(message.type))
  ) {
    fail(`Browser helper received an unsupported message type: ${String(message.type)}`);
  }
  if (typeof message.id !== "string" || !message.id) {
    fail("Browser helper message has no turn identity");
  }
  const positiveInteger = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const revision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  switch (message.type) {
    case "abort":
      if (message.reason !== undefined && message.reason !== "compaction_handoff_accepted")
        fail("Browser helper abort reason is invalid");
      return {
        type: "abort",
        id,
        ...(message.reason === undefined ? {} : { reason: "compaction_handoff_accepted" }),
        ...(message.diagnostic === undefined ? {} : { diagnostic: parseDiagnosticError(message.diagnostic) }),
      };
    case "surface_ownership_ack":
      if (
        (message.phase !== "leased" && message.phase !== "released") ||
        typeof message.surfaceId !== "string" ||
        !/^[A-Za-z0-9_-]{32}$/.test(message.surfaceId) ||
        typeof message.accepted !== "boolean"
      ) {
        fail("Browser helper surface ownership acknowledgement is invalid", true);
      }
      break;
    case "result_ready_ack":
      if (
        typeof message.textSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(message.textSha256) ||
        typeof message.accepted !== "boolean"
      ) {
        fail("Browser helper result persistence acknowledgement is invalid", true);
      }
      break;
    case "tool_batch_observed_ack":
      if (
        !positiveInteger(message.requestId) ||
        !positiveInteger(message.revision) ||
        typeof message.accepted !== "boolean"
      ) {
        fail("Browser helper tool boundary acknowledgement is invalid", true);
      }
      break;
    case "completion_fence_begin_ack":
      if (!positiveInteger(message.requestId) || (message.revision !== null && !revision(message.revision))) {
        fail("Browser helper completion fence revision is invalid", true);
      }
      break;
    case "completion_fence_commit_ack":
      if (!positiveInteger(message.requestId) || typeof message.committed !== "boolean") {
        fail("Browser helper completion fence result is invalid", true);
      }
      break;
  }
  return message as InputMessage;
}

/** Optional internal diagnostics extend existing helper errors; public adapter status/code fields retain their meaning. */
export function createHelperErrorMessage(id: string, error: unknown): Extract<HelperMessage, { type: "error" }> {
  const diagnostic = serializeDiagnosticError(error);
  const root = diagnostic.nodes[0];
  return {
    type: "error",
    id,
    name: root.name,
    message: root.message,
    diagnostic,
    ...(error instanceof ChatGptWebAdapterError
      ? {
          status: error.status,
          errorType: [
            "server_error",
            "invalid_request_error",
            "client_closed_request",
            "rate_limit_error",
            "authentication_error",
          ].includes(error.errorType)
            ? error.errorType
            : "server_error",
          code: root.code,
          retryable: error.retryable,
        }
      : {}),
  };
}

export function helperMessageError(message: Extract<HelperMessage, { type: "error" }>): Error {
  const error =
    message.status !== undefined
      ? new ChatGptWebAdapterError(message.message, {
          status: message.status,
          errorType: message.errorType!,
          code: message.code!,
          retryable: message.retryable!,
        })
      : message.diagnostic !== undefined
        ? deserializeDiagnosticError(message.diagnostic)
        : message.name === "AbortError"
          ? new DOMException(message.message, "AbortError")
          : new Error(message.message);
  if (message.diagnostic) attachDiagnosticError(error, message.diagnostic);
  return error;
}
