import { createHash } from "node:crypto";
import type { CodexMessage } from "../../types";

export interface CompactionEvidenceObservation {
  ref: string;
  messageIndex?: number;
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  command?: string;
  excerpt: string;
}

/** Only a complete, unambiguous execution envelope can establish an exit status. */
export function completedExecutionStatus(
  output: string,
  isError: boolean,
): "succeeded" | "failed" | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return isError ? "failed" : null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return isError ? "failed" : null;
  }
  const result = parsed as Record<string, unknown>;
  if (isError) return "failed";
  if (Number.isSafeInteger(result.session_id)) return null;
  if (result.timed_out === true) return "failed";
  const exitCode = result.exit_code ?? result.exitCode;
  return Number.isSafeInteger(exitCode) ? Number(exitCode) === 0 ? "succeeded" : "failed" : null;
}

export function buildCompactionEvidenceIndex(
  messages: readonly CodexMessage[],
  sessionId: string,
): CompactionEvidenceObservation[] {
  if (!sessionId.trim()) return [];
  const calls = new Map<string, { name: string; command?: string }>();
  const observations: CompactionEvidenceObservation[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        calls.set(part.id, {
          name: part.name,
          ...(typeof part.arguments.cmd === "string" ? { command: part.arguments.cmd } : {}),
        });
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== message.toolName) continue;
    const output = typeof message.content === "string"
      ? message.content
      : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const patch = ["apply_patch", "codex_apply_patch"].includes(message.toolName);
    const execution = ["exec_command", "codex_exec", "write_stdin", "codex_write_stdin"].includes(message.toolName);
    if (!patch && !execution) continue;
    const executionStatus = execution ? completedExecutionStatus(output, message.isError) : null;
    if (execution && !executionStatus) continue;
    if (patch && !message.isError && !/^Success\./m.test(output)) continue;
    const status = executionStatus ?? (message.isError ? "failed" : "succeeded");
    const ref = `obs_${createHash("sha256")
      .update(sessionId).update("\0").update(message.toolCallId).update("\0")
      .update(message.toolName).update("\0").update(call.command ?? "").update("\0")
      .update(status).update("\0").update(output).digest("hex").slice(0, 24)}`;
    observations.push({
      ref,
      messageIndex,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      status,
      ...(call.command ? { command: call.command } : {}),
      excerpt: output.length > 1_200
        ? `${output.slice(0, 600)}\n[recover full output with toolCallId]\n${output.slice(-600)}`
        : output,
    });
  }
  return observations;
}

export function selectCompactionRepairEvidence(
  observations: readonly CompactionEvidenceObservation[],
  query: string,
  limit: number,
): CompactionEvidenceObservation[] {
  if (limit <= 0) return [];
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? [])]
    .filter(term => !["completed", "observation", "requirement", "evidence", "missing", "verified"].includes(term));
  return observations.map((observation, index) => {
    const command = observation.command?.toLowerCase() ?? "";
    const excerpt = observation.excerpt.toLowerCase();
    const score = terms.reduce((total, term) => total
      + (observation.ref.toLowerCase().includes(term) ? 10 : 0)
      + (observation.toolCallId.toLowerCase().includes(term) ? 10 : 0)
      + (command.includes(term) ? 3 : 0)
      + (excerpt.includes(term) ? 1 : 0), 0);
    return { observation, index, score };
  }).sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .map(item => item.observation);
}
