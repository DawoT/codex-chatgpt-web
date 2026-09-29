import { isAbsolute, resolve } from "node:path";
import type { CodexParsedRequest } from "../../../types";
import { clientTurnMetadata, clientTurnMetadataFromBody, isEnvironmentRequest, record } from "./helpers";
import { canonicalSandboxMetadata, sandboxTypeFromMetadata } from "./policy";
import type { ChatGptRootThreadMetadata, ChatGptThreadSpawnLineage, ChatGptTurnIdentity } from "./types";

/** Read only Codex-owned lifecycle identity without interpreting or rewriting the provider body. */
export function extractCodexTurnIdentityFromBody(value: unknown): ChatGptTurnIdentity {
  const metadata = clientTurnMetadataFromBody(value);
  return {
    ...(typeof metadata?.thread_id === "string" ? { threadId: metadata.thread_id } : {}),
    ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
    ...(typeof metadata?.parent_thread_id === "string" ? { parentThreadId: metadata.parent_thread_id } : {}),
    ...(typeof metadata?.agent_name === "string" ? { agentName: metadata.agent_name } : {}),
    ...(typeof metadata?.subagent_kind === "string" ? { subagentKind: metadata.subagent_kind } : {}),
  };
}

export function extractChatGptTurnIdentity(parsed: CodexParsedRequest): ChatGptTurnIdentity {
  if (parsed._hostTurn) {
    return { threadId: parsed._hostTurn.sessionId, turnId: parsed._hostTurn.turnId };
  }
  const body = record(parsed._rawBody);
  return {
    ...extractCodexTurnIdentityFromBody(body),
    ...(typeof body?.prompt_cache_key === "string" ? { promptCacheKey: body.prompt_cache_key } : {}),
  };
}

/**
 * Return the canonical parent link carried by a native Codex thread-spawn request.
 * This is deliberately stricter than generic metadata parsing: only a real child turn with an
 * agent name, explicit turn purpose, sandbox policy, and absolute workspace evidence can inherit
 * filesystem authority from a previously verified parent thread.
 */
export function extractChatGptThreadSpawnLineage(parsed: CodexParsedRequest): ChatGptThreadSpawnLineage | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (!metadata || !isEnvironmentRequest(metadata, parsed) || metadata.subagent_kind !== "thread_spawn")
    return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const parentThreadId = typeof metadata.parent_thread_id === "string" ? metadata.parent_thread_id.trim() : "";
  const agentName = typeof metadata.agent_name === "string" ? metadata.agent_name.trim() : "";
  if (
    !threadId ||
    !parentThreadId ||
    threadId === parentThreadId ||
    (agentName !== "/root" && !/^\/root\/.+/.test(agentName))
  )
    return undefined;

  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!sandboxType || sandboxType === "platform") return undefined;
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (workspacePaths.some((path) => !isAbsolute(path))) return undefined;
  const workspaceRoots = [...new Set(workspacePaths.map((path) => resolve(path)))];
  return { threadId, parentThreadId, agentName, sandboxType, workspaceRoots };
}

/** Root tasks have no spawn edge; their canonical session and current turn must prove authority. */
export function extractChatGptRootThreadMetadata(parsed: CodexParsedRequest): ChatGptRootThreadMetadata | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (
    !metadata ||
    !isEnvironmentRequest(metadata, parsed) ||
    metadata.parent_thread_id != null ||
    metadata.subagent_kind != null ||
    (metadata.agent_name != null && metadata.agent_name !== "/root")
  )
    return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (!threadId || !sandboxType || workspacePaths.some((path) => !isAbsolute(path))) return undefined;
  return { threadId, sandboxType, workspaceRoots: [...new Set(workspacePaths.map((path) => resolve(path)))] };
}

/**
 * Detect whether a parsed Codex request represents an atomic subagent turn.
 * Subagents have a parentThreadId, a subagent_kind (e.g. thread_spawn),
 * an agentName other than /root, or valid thread-spawn lineage.
 */
export function isChatGptSubagentTurn(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  return Boolean(
    identity.parentThreadId ||
      identity.subagentKind ||
      (identity.agentName && identity.agentName !== "/root") ||
      extractChatGptThreadSpawnLineage(parsed),
  );
}
