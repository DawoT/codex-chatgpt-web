import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { truncateToolOutputText } from "./fast-path-handlers";
import { runtimeMetrics } from "./runtime-metrics";

/**
 * Sprint T: MCP Tool Output Offloading & Spooling (.agents/scratch/outputs/)
 * Intercepts tool outputs exceeding the safety threshold and spools the full raw
 * payload to disk, returning a compact structured summary (head + tail + file path)
 * to ChatGPT Web. This prevents context exhaustion while preserving total auditability.
 * 
 * Sprint Z: Storage Hygiene & Rolling FIFO/TTL Retention Policy.
 */

export const DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS = 2_500;
export const DEFAULT_HEAD_LINES = 15;
export const DEFAULT_TAIL_LINES = 15;
export const DEFAULT_SCRATCH_MAX_FILES = 200;
export const DEFAULT_SCRATCH_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
export const DEFAULT_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PruningPolicy {
  maxFiles?: number;
  maxBytes?: number;
  maxAgeMs?: number;
}

export interface PruneResult {
  deletedCount: number;
  deletedBytes: number;
  remainingCount: number;
  remainingBytes: number;
}

export interface ToolSpoolerDeps {
  writeFileSync?: (path: string, data: string, encoding: string) => void;
  resolveDirectory?: (workspaceRoot?: string, subagentId?: string) => string;
}

export interface ToolSpoolerOptions {
  workspaceRoot?: string;
  subagentId?: string;
  maxChars?: number;
  headLines?: number;
  tailLines?: number;
  toolName?: string;
  callId?: string;
  pruningPolicy?: PruningPolicy;
  deps?: ToolSpoolerDeps;
}

export interface SpoolResult {
  text: string;
  spooled: boolean;
  filePath?: string;
  originalLength?: number;
}

function sanitizeForFileName(input: string): string {
  return input.replace(/[^\w.-]/g, "_").slice(0, 32);
}

/**
 * Prunes the scratch outputs directory enforcing max files (FIFO), max total bytes,
 * and maximum age (TTL) policies.
 */
export function pruneScratchDirectory(
  scratchDir: string,
  policy: PruningPolicy = {},
): PruneResult {
  if (!existsSync(scratchDir)) {
    return { deletedCount: 0, deletedBytes: 0, remainingCount: 0, remainingBytes: 0 };
  }

  const maxFiles = policy.maxFiles;
  const maxBytes = policy.maxBytes;
  const maxAgeMs = policy.maxAgeMs;

  let deletedCount = 0;
  let deletedBytes = 0;

  try {
    const entries = readdirSync(scratchDir);
    const now = Date.now();

    interface FileEntry {
      name: string;
      fullPath: string;
      size: number;
      mtimeMs: number;
    }

    let files: FileEntry[] = [];

    for (const name of entries) {
      const fullPath = join(scratchDir, name);
      try {
        const st = statSync(fullPath);
        if (st.isFile()) {
          // 1. Age-based TTL pruning
          if (maxAgeMs !== undefined && now - st.mtimeMs > maxAgeMs) {
            unlinkSync(fullPath);
            deletedCount += 1;
            deletedBytes += st.size;
          } else {
            files.push({ name, fullPath, size: st.size, mtimeMs: st.mtimeMs });
          }
        }
      } catch {
        // Ignore individual file stat error
      }
    }

    // Sort remaining files by mtimeMs ascending (oldest first)
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // 2. Count-based pruning (FIFO: oldest files removed first)
    if (maxFiles !== undefined && files.length > maxFiles) {
      const excessCount = files.length - maxFiles;
      const toDelete = files.slice(0, excessCount);
      for (const item of toDelete) {
        try {
          unlinkSync(item.fullPath);
          deletedCount += 1;
          deletedBytes += item.size;
        } catch {
          // Ignore removal error
        }
      }
      files = files.slice(excessCount);
    }

    // 3. Size-based pruning (remove oldest files until totalBytes <= maxBytes)
    if (maxBytes !== undefined) {
      let currentTotalBytes = files.reduce((sum, f) => sum + f.size, 0);
      while (files.length > 0 && currentTotalBytes > maxBytes) {
        const oldest = files.shift()!;
        try {
          unlinkSync(oldest.fullPath);
          deletedCount += 1;
          deletedBytes += oldest.size;
          currentTotalBytes -= oldest.size;
        } catch {
          // Ignore removal error
        }
      }
    }

    const remainingCount = files.length;
    const remainingBytes = files.reduce((sum, f) => sum + f.size, 0);

    return { deletedCount, deletedBytes, remainingCount, remainingBytes };
  } catch {
    return { deletedCount, deletedBytes, remainingCount: 0, remainingBytes: 0 };
  }
}

/**
 * Resolves or creates the scratch outputs directory inside the project's .agents/scratch/outputs
 * or subagent's .agents/subagents/<id>/scratch/outputs if subagentId is provided.
 * Falls back safely to ~/.codex-chatgpt-web/scratch/outputs if workspace is missing or unwritable.
 */
export function resolveProjectScratchDirectory(workspaceRoot?: string, subagentId?: string): string {
  const safeSubId = subagentId ? sanitizeForFileName(subagentId) : undefined;
  if (workspaceRoot && typeof workspaceRoot === "string") {
    try {
      const candidate = safeSubId
        ? resolve(workspaceRoot, ".agents", "subagents", safeSubId, "scratch", "outputs")
        : resolve(workspaceRoot, ".agents", "scratch", "outputs");
      mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // Fall through to global directory fallback if workspace cannot be written
    }
  }

  const fallback = safeSubId
    ? join(homedir(), ".codex-chatgpt-web", "subagents", safeSubId, "scratch", "outputs")
    : join(homedir(), ".codex-chatgpt-web", "scratch", "outputs");
  try {
    mkdirSync(fallback, { recursive: true });
  } catch {
    // If even fallback directory cannot be created, return path as-is
  }
  return fallback;
}

/**
 * Spools oversized tool text output to disk and returns a concise head/tail representation.
 * If output is within budget, it is returned untouched without disk I/O.
 */
export function spoolToolOutput(text: string, options: ToolSpoolerOptions = {}): SpoolResult {
  const maxChars = options.maxChars ?? DEFAULT_TOOL_OFFLOAD_THRESHOLD_CHARS;
  if (typeof text !== "string" || text.length <= maxChars) {
    return { text, spooled: false };
  }

  const headLinesCount = options.headLines ?? DEFAULT_HEAD_LINES;
  const tailLinesCount = options.tailLines ?? DEFAULT_TAIL_LINES;
  const write = options.deps?.writeFileSync ?? writeFileSync;
  const resolveDir = options.deps?.resolveDirectory ?? resolveProjectScratchDirectory;

  try {
    const scratchDir = resolveDir(options.workspaceRoot, options.subagentId);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
    const prefix = sanitizeForFileName(options.toolName || "tool");
    const id = sanitizeForFileName(options.callId || randomBytes(4).toString("hex"));
    const filename = `${prefix}_${id}_${hash}.log`;
    const targetFilePath = join(scratchDir, filename);
    write(targetFilePath, text, "utf-8");
    // Record spooler write metrics (non-blocking, never throws)
    try { runtimeMetrics.recordSpoolerWrite(text.length); } catch { /* ignore */ }

    // Opportunistically prune scratch directory according to retention policy
    try {
      pruneScratchDirectory(scratchDir, options.pruningPolicy);
    } catch {
      // Best-effort pruning; failure must never fail tool output spooling
    }

    // Extract lines for Head & Tail
    const lines = text.split("\n");
    let headPart = "";
    let tailPart = "";

    if (lines.length > headLinesCount + tailLinesCount) {
      headPart = lines.slice(0, headLinesCount).join("\n");
      tailPart = lines.slice(-tailLinesCount).join("\n");
    } else {
      // When there are few newlines (e.g. solid block of text or long minified JSON),
      // slice characters symmetrically
      const charBudget = Math.floor(maxChars * 0.35);
      headPart = text.slice(0, charBudget);
      tailPart = text.slice(-charBudget);
    }

    const kbSize = (Buffer.byteLength(text, "utf-8") / 1024).toFixed(1);
    const summaryText = [
      `[Output truncated and offloaded to disk: ${lines.length} lines (${kbSize} KB) saved to: ${targetFilePath} (output truncated to protect context)]`,
      `--- Head (first ${headLinesCount} lines) ---`,
      headPart,
      `--- Tail (last ${tailLinesCount} lines) ---`,
      tailPart,
      "---",
      "Hint: To inspect specific sections, use read_file with offset/limit_lines or grep on the offloaded log file.",
    ].join("\n");

    return {
      text: summaryText,
      spooled: true,
      filePath: targetFilePath,
      originalLength: text.length,
    };
  } catch (error) {
    // Fail-safe: if disk writing fails for any reason, fallback to in-memory truncation
    const fallbackText = truncateToolOutputText(text, maxChars);
    return {
      text: fallbackText,
      spooled: false,
      originalLength: text.length,
    };
  }
}

/**
 * Sanitizes an array of tool output content parts, replacing oversized text parts with spooled summaries.
 */
export function sanitizeToolOutputWithSpooler(content: unknown[], options: ToolSpoolerOptions = {}): unknown[] {
  if (!Array.isArray(content)) return content;

  return content.map(part => {
    if (
      part !== null
      && typeof part === "object"
      && !Array.isArray(part)
      && "type" in part
      && (part as { type: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ) {
      const textPart = part as { type: "text"; text: string; [key: string]: unknown };
      const spooled = spoolToolOutput(textPart.text, options);
      if (spooled.spooled || spooled.text !== textPart.text) {
        return {
          ...textPart,
          text: spooled.text,
          ...(spooled.filePath ? { offloadedPath: spooled.filePath } : {}),
        };
      }
    }
    return part;
  });
}
