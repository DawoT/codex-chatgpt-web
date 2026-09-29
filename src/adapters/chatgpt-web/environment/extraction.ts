import { isAbsolute } from "node:path";
import type { CodexParsedRequest } from "../../../types";
import { recoverCompactionInstruction } from "../compaction-continuation";
import {
  clientTurnMetadata,
  contentText,
  hasAssistantOutputBetween,
  itemTurnId,
  matchesPath,
  pathIdentity,
  rawMessageText,
  record,
  uniqueAbsolutePaths,
} from "./helpers";
import { extractChatGptTurnIdentity } from "./identity";
import { compactionSummaryMessage, hasEnvironmentContextFragment, isNativeInstruction } from "./instructions";
import {
  canonicalSandboxMetadata,
  environmentCwdMatches,
  environmentMatchesCanonicalMetadata,
  sandboxMetadataMatchesEnvironment,
  sandboxTypeFromEnvironment,
} from "./policy";
import type { ChatGptTurnEnvironment, ChatGptUnattributedEnvironmentMessage } from "./types";

/** True when the raw Responses input attempted to carry an environment envelope, valid or not. */
export function hasRawChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some((value) => hasEnvironmentContextFragment(record(value)));
}

/** Historical XML is not a current environment update, including in old untagged rollouts. */
export function hasCurrentChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return hasRawChatGptEnvironmentContext(parsed);
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let laterAssistantOutput = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    if (
      (item.type === "message" && item.role === "assistant") ||
      item.type === "function_call" ||
      item.type === "reasoning" ||
      item.type === "compaction"
    ) {
      laterAssistantOutput = true;
    }
    if (!hasEnvironmentContextFragment(item)) continue;
    const owner = itemTurnId(item);
    if (owner === turnId || (owner === undefined && !laterAssistantOutput)) return true;
  }
  return false;
}

/** These are claims to locate in native history, never a source of filesystem authority. */
export function unattributedChatGptEnvironmentMessages(
  parsed: CodexParsedRequest,
): ChatGptUnattributedEnvironmentMessage[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  const messages: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const value of input) {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) continue;
    // Explicit current provenance must keep the normal current-update rejection. A native item
    // without provenance is historical only if the canonical rollout proves that exact message.
    const owner = itemTurnId(item);
    if (owner !== undefined && owner !== currentTurnId) continue;
    if (owner !== undefined || item.role !== "user" || typeof item.id !== "string" || !item.id) return undefined;
    messages.push({ id: item.id, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}

export function environmentBeforeUser(
  input: unknown[],
  userIndex: number,
  expectedTurnId?: string,
  metadata?: Record<string, unknown>,
): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata)) return undefined;

  const userTurnId = itemTurnId(user);
  if (!userTurnId || (expectedTurnId && userTurnId !== expectedTurnId)) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && candidate.role === "developer") {
    const developerTurnId = itemTurnId(candidate);
    if (developerTurnId !== userTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user") return undefined;

  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== userTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) {
      const policyClaim = metadata ? canonicalSandboxMetadata(metadata) : undefined;
      if (policyClaim !== undefined && !sandboxMetadataMatchesEnvironment(policyClaim, trimmed)) return undefined;
      return trimmed;
    }
  }
  return undefined;
}

export function canonicalMetadataEnvironmentBefore(
  input: unknown[],
  anchorIndex: number,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots = false,
): string | undefined {
  const metadataTurnId = metadata.turn_id;
  if (typeof metadataTurnId !== "string" || !metadataTurnId.trim()) return undefined;

  let candidateIndex = anchorIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && (candidate.role === "developer" || compactionSummaryMessage(candidate))) {
    const developerTurnId = itemTurnId(candidate);
    const serverOwnedId = typeof candidate.id === "string" && candidate.id.length > 0;
    if (developerTurnId === undefined ? !serverOwnedId : developerTurnId !== metadataTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user" || typeof candidate.id !== "string" || !candidate.id)
    return undefined;
  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== undefined && candidateTurnId !== metadataTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) continue;
    if (!environmentMatchesCanonicalMetadata(trimmed, metadata, requireMetadataBoundRoots)) continue;
    return trimmed;
  }
  return undefined;
}

export function canonicalMetadataEnvironmentBeforeUser(
  input: unknown[],
  userIndex: number,
  metadata: Record<string, unknown> | undefined,
  requireMetadataBoundRoots = false,
): string | undefined {
  if (userIndex <= 0 || !metadata) return undefined;
  const metadataTurnId = typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const _metadataSandbox = sandboxTypeFromEnvironment(metadata.sandbox ? String(metadata.sandbox) : "");
  if (!metadataTurnId && !metadata.sandbox) return undefined;

  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata) || typeof user.id !== "string" || !user.id) return undefined;
  const userTurnId = itemTurnId(user);
  if (userTurnId !== undefined && userTurnId !== metadataTurnId) return undefined;

  return canonicalMetadataEnvironmentBefore(input, userIndex, metadata, requireMetadataBoundRoots);
}

/**
 * Native world-state diffs omit unchanged cwd/shell at midnight but repeat the filesystem
 * profile. Recognize the observed unrestricted calendar fragment as a claim only: the store
 * still requires this exact turn's native rollout and corroborating current sandbox metadata.
 * Unknown profiles/fields are deliberately not classified as permission-neutral updates.
 */
export function hasChatGptCalendarEnvironmentDelta(parsed: CodexParsedRequest): boolean {
  const metadata = clientTurnMetadata(parsed);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!metadata || !turnId) return false;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const activeIndex = input.findLastIndex((value) => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return false;

  let deltas = 0;
  for (let index = activeIndex + 1; index < input.length; index += 1) {
    const item = record(input[index]);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (
      item.role !== "user" ||
      itemTurnId(item) !== turnId ||
      typeof item.id !== "string" ||
      !item.id ||
      !hasAssistantOutputBetween(input, activeIndex + 1, index)
    )
      return false;
    const text = rawMessageText(item).trim();
    if (
      !/^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*<permission_profile type="disabled">\s*<file_system type="unrestricted"\s*\/>\s*<\/permission_profile>\s*<\/filesystem>\s*<\/environment_context>$/.test(
        text,
      ) ||
      !sandboxMetadataMatchesEnvironment(canonicalSandboxMetadata(metadata), text) ||
      [metadata.sandbox_mode, metadata.sandbox].some(
        (value) => value !== undefined && !sandboxMetadataMatchesEnvironment(value, text),
      )
    )
      return false;
    deltas += 1;
  }
  return deltas > 0;
}

function clientMetadataWorkspaceRoots(parsed: CodexParsedRequest): string[] {
  const workspaces = record(clientTurnMetadata(parsed)?.workspaces);
  if (!workspaces) return [];
  const roots = Object.keys(workspaces);
  if (roots.some((path) => !isAbsolute(path))) return [];
  return [...new Set(roots.map(pathIdentity))];
}

function rawEnvironmentText(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (isNativeInstruction(item, metadata)) {
      activeUserIndex = index;
      break;
    }
  }
  const checkpoint =
    activeUserIndex < 0 ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  const anchorIndex = checkpoint?.summaryIndex ?? activeUserIndex;
  const turnId = metadata?.turn_id;
  if (
    input.slice(anchorIndex + 1).some((value) => {
      const item = record(value);
      return hasEnvironmentContextFragment(item) && (itemTurnId(item) === undefined || itemTurnId(item) === turnId);
    })
  )
    return undefined;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
    metadata,
  );
  if (currentByTurn) return currentByTurn;

  const current =
    checkpoint && metadata
      ? canonicalMetadataEnvironmentBefore(input, checkpoint.summaryIndex, metadata)
      : canonicalMetadataEnvironmentBeforeUser(input, activeUserIndex, metadata);
  if (current) return current;

  let crossedAssistantOutput = false;
  for (let index = activeUserIndex - 1; index > 0; index -= 1) {
    crossedAssistantOutput ||= hasAssistantOutputBetween(input, index, index + 1);
    if (crossedAssistantOutput && itemTurnId(input[index]) !== turnId) continue;
    const sameTurn = canonicalMetadataEnvironmentBeforeUser(input, index, metadata, true);
    if (sameTurn) return sameTurn;
  }

  if (hasCurrentChatGptEnvironmentContext(parsed)) return undefined;

  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  for (let index = replayPrefixLen - 1; index > 0; index -= 1) {
    const replayed = environmentBeforeUser(input, index, undefined, metadata);
    if (replayed) return replayed;
  }

  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  const currentThreadId =
    typeof metadata?.thread_id === "string" && metadata.thread_id.trim() ? metadata.thread_id : undefined;
  const activeUser = record(input[activeUserIndex]);
  const activeUserOwned =
    isNativeInstruction(activeUser, metadata) &&
    typeof activeUser.id === "string" &&
    activeUser.id.length > 0 &&
    itemTurnId(activeUser) === currentTurnId;
  if (currentTurnId && itemTurnId(activeUser) === currentTurnId) {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const historicalUser = record(input[index]);
      const historicalTurnId = itemTurnId(historicalUser);
      if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
      const historical = environmentBeforeUser(input, index, undefined, metadata);
      if (!historical) continue;
      if (hasAssistantOutputBetween(input, index + 1, activeUserIndex)) return historical;
      if (!currentThreadId || !metadata || !activeUserOwned) continue;
      const bounded = canonicalMetadataEnvironmentBeforeUser(
        input,
        index,
        { ...metadata, turn_id: historicalTurnId, sandbox: canonicalSandboxMetadata(metadata) },
        true,
      );
      if (bounded === historical) return bounded;
    }
  }
  return undefined;
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const raw = rawEnvironmentText(parsed);
  if (raw) return raw;
  if (parsed._rawBody !== undefined) return "";
  const system = parsed.context.systemPrompt ?? [];
  const developer = parsed.context.messages
    .filter((message) => message.role === "developer")
    .map((message) => contentText(message.content));
  return [...system, ...developer].join("\n");
}

function parseChatGptEnvironmentText(parsed: CodexParsedRequest, text: string): ChatGptTurnEnvironment {
  const cwdMatches = environmentCwdMatches(text, clientMetadataWorkspaceRoots(parsed));
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) throw new Error("ChatGPT web turn has conflicting trusted Codex cwd values");
  const cwd = cwdCandidates[0]!;

  const rootMatches = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)].flatMap((section) =>
    [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map((match) => match[1] ?? ""),
  );
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some((root) => matchesPath(root, cwd))) {
    throw new Error("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }

  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess =
    /<network_access>enabled<\/network_access>/i.test(text) || /network access is enabled/i.test(text);

  if (!sandboxType) {
    throw new Error("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: parsed.context.tools ?? [],
    };
  }
  if (sandboxType === "workspaceWrite") {
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess },
      tools: parsed.context.tools ?? [],
    };
  }
  return {
    cwd,
    roots,
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess },
    tools: parsed.context.tools ?? [],
  };
}

export function extractChatGptTurnEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  return parseChatGptEnvironmentText(parsed, trustedEnvironmentText(parsed));
}

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const updates = (Array.isArray(body?.input) ? body.input : []).flatMap((value) => {
    const item = record(value);
    if (
      item?.type !== "message" ||
      item.role !== "user" ||
      itemTurnId(item) !== turnId ||
      typeof item.id !== "string" ||
      !item.id
    )
      return [];
    const parts =
      typeof item.content === "string"
        ? [item.content]
        : Array.isArray(item.content)
          ? item.content.map((part) => record(part)?.text)
          : [];
    return parts.flatMap((value) => {
      if (typeof value !== "string") return [];
      const text = value.trim();
      return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? [text] : [];
    });
  });
  if (updates.length !== 1) throw new Error("Compaction continuation requires one current native environment claim");
  return parseChatGptEnvironmentText(parsed, updates[0]!);
}

/**
 * Steering can separate the original environment/instruction pair from the active instruction.
 * Git workspace metadata need not list every native filesystem root. Return that earlier claim
 * only for a same-turn pair; the store must compare it with the current canonical rollout.
 */
export function extractChatGptSteeringEnvironmentClaim(parsed: CodexParsedRequest): ChatGptTurnEnvironment | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const activeIndex = input.findLastIndex((value) => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;

  const claims = input.flatMap((value, index) => {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) return [];
    const owner = itemTurnId(item);
    return owner === undefined || owner === turnId ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const claim = claims[0]!;
  if (
    claim.item.role !== "user" ||
    itemTurnId(claim.item) !== turnId ||
    typeof claim.item.id !== "string" ||
    !claim.item.id
  )
    return undefined;
  const parts = Array.isArray(claim.item.content) ? claim.item.content : [];
  if (parts.filter((part) => /<\/?environment_context\b/i.test(String(record(part)?.text ?? ""))).length !== 1)
    return undefined;

  for (let index = claim.index + 1; index < activeIndex; index += 1) {
    const instruction = record(input[index]);
    if (typeof instruction?.id !== "string" || !instruction.id) continue;
    const text = environmentBeforeUser(input, index, turnId, metadata);
    if (text) return parseChatGptEnvironmentText(parsed, text);
  }
  return undefined;
}
