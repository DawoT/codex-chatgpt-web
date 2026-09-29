import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "../environment";
import { namespacedToolName } from "../../../types";
import { TurnBrokerProtocolError, TurnBrokerRequestError } from "./errors";

export const MAX_BROKER_LINE_CHARS = 67_108_864;
export const MAX_RETIRED_TURN_HANDLES = 64;

/**
 * How long an unsettled MCP activity lease may keep its channel's completion fence vetoed.
 *
 * A claim resolved through an alias or trace lineage registers its activity on the successor
 * channel, so a claimant that dies before `activity_complete` would veto every later fence on
 * that channel forever. Past this bound the lease is treated as abandoned and swept.
 */
export const MAX_ACTIVITY_LIVENESS_MS = 120_000;

/** Alias chains are bounded like retired-handle history; the broker is a process singleton. */
export const MAX_TOKEN_ALIASES = 256;

/**
 * Completed-activity tombstones are bounded with the same eviction style as the alias chains.
 *
 * A tombstone only needs to outlive the retries that could resurrect its lease, so the oldest
 * entries give way first while recent ones keep blocking duplicate claims.
 */
export const MAX_COMPLETED_ACTIVITY_TOMBSTONES = 256;

/**
 * Bytes available for a Unix socket path. Linux allows 108, macOS and the BSDs expose a 104-byte
 * sun_path including its terminating NUL; the smaller usable bound is used everywhere so a path
 * that works on one developer's machine is not silently unbindable on another's.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function handleFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function retiredTurnLabel(traceId: string): string {
  return traceId && traceId !== "unknown" ? `Codex turn ${traceId}` : "a Codex turn";
}

export function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  return JSON.stringify({
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    execution: environment.execution,
    ...(environment.execution === "host-only" ? { tools: environment.tools } : {}),
  });
}

export function ownerEnvironment(value: unknown): ChatGptTurnEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TurnBrokerProtocolError("turn owner environment is invalid");
  const environment = value as Partial<ChatGptTurnEnvironment>;
  const paths = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && (candidate.length > 0 || environment.execution === "host-only")
    && candidate.every(path => typeof path === "string" && isAbsolute(path));
  if (typeof environment.cwd !== "string" || !isAbsolute(environment.cwd)
    || (environment.execution !== undefined && environment.execution !== "host-only")
    || !paths(environment.roots) || !Array.isArray(environment.writableRoots)
    || environment.writableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || (environment.execution !== "host-only" && !environment.roots.some(root => {
      const nested = relative(resolve(root), resolve(environment.cwd!));
      return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
    }))
    || !environment.sandboxPolicy || !["dangerFullAccess", "workspaceWrite", "readOnly"].includes(environment.sandboxPolicy.type)
    || !Array.isArray(environment.tools)
    || environment.tools.some(tool => !tool || typeof tool.name !== "string" || typeof tool.description !== "string"
      || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
    throw new TurnBrokerProtocolError("turn owner environment is invalid");
  }
  if (environment.execution === "host-only") {
    const names = new Set<string>();
    for (const tool of environment.tools!) {
      if (!tool.name || (tool.namespace !== undefined && typeof tool.namespace !== "string")) {
        throw new TurnBrokerProtocolError("host-only tool identity is invalid");
      }
      const name = namespacedToolName(tool.namespace, tool.name);
      if (names.has(name)) throw new TurnBrokerProtocolError("host-only tool identities must be unique");
      names.add(name);
    }
  }
  return structuredClone(environment as ChatGptTurnEnvironment);
}

export function assertSurfaceNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) {
    throw new TurnBrokerRequestError("Zero Risk local browser binding is invalid");
  }
}

/** Evicts by insertion order (oldest out), the same bound style as the retired-handle history. */
export function trimOldest(history: Map<string, string> | Set<string>, limit: number): void {
  while (history.size > limit) {
    const oldest = history.keys().next();
    if (oldest.done) return;
    history.delete(oldest.value);
  }
}
