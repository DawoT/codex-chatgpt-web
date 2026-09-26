import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { expandUserPath, type AppConfig } from "../../config";
import type { ChatGptTurnEnvironment } from "./environment";

export const CHAT_FIRST_SANDBOX_MODES = ["readOnly", "workspaceWrite", "dangerFullAccess"] as const;
export type ChatFirstSandboxMode = (typeof CHAT_FIRST_SANDBOX_MODES)[number];

/**
 * Actionable chat-first configuration error: disabled contract, unsupported sandbox mode or a
 * requested workspace that the config does not allow.
 */
export class ChatFirstEnvironmentError extends Error {}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function matchesPath(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function validatedChatFirst(config: AppConfig): { mode: ChatFirstSandboxMode; workspaces: string[] } {
  if (!config.chatFirst?.enabled) {
    throw new ChatFirstEnvironmentError("chat-first is not enabled in config.json");
  }
  const mode = config.chatFirst.sandboxMode;
  if (!(CHAT_FIRST_SANDBOX_MODES as readonly string[]).includes(mode)) {
    throw new ChatFirstEnvironmentError(
      `chat-first sandboxMode ${JSON.stringify(mode)} in config.json is not one of:`
      + ` ${CHAT_FIRST_SANDBOX_MODES.join(", ")}`,
    );
  }
  const configured = config.chatFirst.workspaces?.length ? config.chatFirst.workspaces : [];
  if (mode === "workspaceWrite" && configured.length === 0) {
    throw new ChatFirstEnvironmentError(
      "chat-first sandboxMode workspaceWrite requires at least one chatFirst.workspaces entry in config.json",
    );
  }
  return { mode, workspaces: [...configured] };
}

/**
 * Builds the trusted Codex turn environment for the chat-first contract, where ChatGPT Web calls
 * arrive without a turn token and the environment is derived entirely from config.json.
 */
export function buildChatFirstEnvironment(config: AppConfig): ChatGptTurnEnvironment {
  const { mode, workspaces } = validatedChatFirst(config);
  if (mode === "dangerFullAccess") {
    return {
      cwd: homedir(),
      roots: ["/"],
      writableRoots: ["/"],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    };
  }
  if (mode === "workspaceWrite") {
    return {
      cwd: workspaces[0]!,
      roots: [...workspaces],
      writableRoots: [...workspaces],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [...workspaces], networkAccess: false },
      tools: [],
    };
  }
  return {
    cwd: workspaces[0] ?? homedir(),
    roots: workspaces.length > 0 ? [...workspaces] : [homedir()],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [],
  };
}

/**
 * Resolves the effective turn workspace for a chat-first call. `requested` may be an absolute
 * path inside a configured workspace, a workspace path itself, or the unique basename of one.
 */
export function resolveChatFirstWorkspace(
  config: AppConfig,
  requested?: string,
): { cwd: string; roots: string[]; writableRoots: string[] } {
  const { mode, workspaces } = validatedChatFirst(config);
  if (mode === "dangerFullAccess") {
    let cwd = homedir();
    if (requested !== undefined && requested.trim()) {
      const expanded = expandUserPath(requested.trim());
      if (!isAbsolute(expanded)) {
        throw new ChatFirstEnvironmentError(
          `chat-first workspace ${JSON.stringify(requested)} must be an absolute path in dangerFullAccess mode`,
        );
      }
      cwd = resolve(expanded);
    }
    return { cwd, roots: ["/"], writableRoots: ["/"] };
  }

  const roots = mode === "workspaceWrite" || workspaces.length > 0 ? [...workspaces] : [homedir()];
  const writableRoots = mode === "workspaceWrite" ? [...workspaces] : [];
  const defaultCwd = workspaces[0] ?? homedir();

  if (requested === undefined || !requested.trim()) {
    return { cwd: defaultCwd, roots, writableRoots };
  }

  const trimmed = requested.trim();
  const expanded = expandUserPath(trimmed);
  const requestedPath = isAbsolute(expanded) ? resolve(expanded) : undefined;
  const requestedName = basename(trimmed);

  if (requestedPath && workspaces.some(workspace => pathIdentity(workspace) === pathIdentity(requestedPath))) {
    return { cwd: requestedPath, roots, writableRoots };
  }
  const byName = workspaces.filter(workspace => basename(workspace) === requestedName);
  if (byName.length === 1) {
    return { cwd: byName[0]!, roots, writableRoots };
  }
  if (requestedPath && roots.some(root => matchesPath(root, requestedPath))) {
    return { cwd: requestedPath, roots, writableRoots };
  }

  throw new ChatFirstEnvironmentError(
    `chat-first workspace ${JSON.stringify(requested)} does not match any configured chat-first workspace`
    + `; valid chat-first workspaces: ${roots.map(root => JSON.stringify(root)).join(", ")}`,
  );
}
