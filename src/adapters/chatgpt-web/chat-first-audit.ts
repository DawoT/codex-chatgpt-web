import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config";

/**
 * Local audit trail for the chat-first MCP contract. Every successful mutating tool call
 * (codex_write_file, codex_patch_file) appends one JSONL line under the runtime directory so the
 * operator can reconstruct which workspace files the chat-first connector changed. The audit is
 * fail-open by design: a logging failure must never turn a completed mutation into a tool error,
 * but it is always attempted and reported on stderr when it cannot be written.
 */

const CHAT_FIRST_AUDIT_FILE = "chat-first-audit.jsonl";
/** Rotate the JSONL log once it exceeds 5 MB so a long-lived connector cannot grow it unbounded. */
const CHAT_FIRST_AUDIT_MAX_BYTES = 5 * 1024 * 1024;

export interface ChatFirstAuditEntry {
  tool: string;
  path: string;
  bytes?: number;
  detail?: string;
}

export function chatFirstAuditLogPath(): string {
  return join(getConfigDir(), "runtime", CHAT_FIRST_AUDIT_FILE);
}

export function appendChatFirstAuditEntry(entry: ChatFirstAuditEntry): void {
  try {
    const auditPath = chatFirstAuditLogPath();
    mkdirSync(join(getConfigDir(), "runtime"), { recursive: true, mode: 0o700 });
    try {
      // renameSync replaces an existing .1 on every supported platform, so the previous
      // rotation is intentionally discarded instead of accumulating generations.
      if (existsSync(auditPath) && statSync(auditPath).size > CHAT_FIRST_AUDIT_MAX_BYTES) {
        renameSync(auditPath, `${auditPath}.1`);
      }
    } catch (rotationError) {
      // Rotation is best-effort; an oversized log must not block the audit record.
      console.error(
        `[chatgpt-web-mcp] chat-first audit rotation failed: ${
          rotationError instanceof Error ? rotationError.message : String(rotationError)
        }`,
      );
    }
    const record = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      path: entry.path,
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    };
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  } catch (error) {
    console.error(
      `[chatgpt-web-mcp] chat-first audit write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
