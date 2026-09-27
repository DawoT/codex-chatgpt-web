import { homedir } from "node:os";
import { join } from "node:path";

export const GLOBAL_SKILL_READ_ROOTS: readonly string[] = [
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".gemini", "config", "skills"),
  join(homedir(), ".dsh", "skills"),
  join(homedir(), ".config", "codex", "skills"),
];

// A type alias (not an interface) keeps the shape assignable to the MCP SDK's index-signature
// CallToolResult without extra casts at every registerTool call site.
export type FastPathToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function result(value: Record<string, unknown>, isError = false): FastPathToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export const CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS = 16_000;

export interface TruncateHeadTailOptions {
  headRatio?: number;
  tailRatio?: number;
  headChars?: number;
  tailChars?: number;
}

export interface RgExecution {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RgExecutor = (rgPath: string, args: string[], options: { cwd: string }) => RgExecution;

export interface RgResolverDeps {
  /** Injectable for tests; production uses Bun.which. */
  which?: (name: string) => string | null;
  /** Injectable for tests; production uses node:fs.existsSync. */
  exists?: (path: string) => boolean;
  /** Injectable clock for tests; production uses Date.now. */
  now?: () => number;
}

export const RG_FAILURE_CACHE_TTL_MS = 30_000;

export type FastPathToolCall = {
  tool: string;
  arguments: Record<string, unknown>;
  id?: string;
};

export type FastPathBatchResult = {
  id?: string;
  tool: string;
  result: FastPathToolResult;
};
