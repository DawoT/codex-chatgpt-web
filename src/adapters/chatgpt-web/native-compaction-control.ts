import { COMPACT_PROMPT } from "../../responses/compaction";
import type { CompactionEvidenceObservation } from "./compaction-evidence";
import type { CompactionTransactionHandle } from "./compaction-transaction";

export const CODEX_COMPACTION_CONTROL_WIRE_NAME = "codex.control.compaction_handoff";
export const CODEX_ACTIVE_COMPACTION_REQUEST_MARKER = "CODEX_ACTIVE_COMPACTION_REQUEST";

function compactionControlBinding(transaction: CompactionTransactionHandle): string[] {
  return [
    "Submit the handoff through the reserved Codex MCP operation:",
    "<codex_compaction_control>",
    `turn_token ${transaction.token}`,
    `wire_name ${CODEX_COMPACTION_CONTROL_WIRE_NAME}`,
    `handoff_id ${transaction.handoffId}`,
    "</codex_compaction_control>",
    JSON.stringify({
      turn_token: transaction.token,
      wire_name: CODEX_COMPACTION_CONTROL_WIRE_NAME,
      arguments: {
        handoff_id: transaction.handoffId,
        summary: "<your handoff>",
      },
    }),
    "This token is only for the handoff; do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool.",
  ];
}

/**
 * Stop an active browser response only if it asks for another tool after Codex requested
 * compaction. Results for calls already handed to Codex remain byte-for-byte canonical: when they
 * are enough to finish the task, that ordinary final answer remains publishable. A later tool call
 * is intercepted before execution and receives this instruction; the retained conversation then
 * receives the sole structured checkpoint request on a clean message boundary.
 */
export function activeCompactionToolResultInstruction(): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    "Codex reached its context limit before this newly requested tool could be sent for execution. The tool was not executed.",
    "Stop ordinary task work now, call no more tools, and end this Web response normally.",
    "Do not create or submit a checkpoint in this response. After it settles, the retained conversation will receive exactly one separate structured compaction handoff request.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

/**
 * Zero Risk cannot submit a second browser message automatically. When Codex compacts at an
 * already-visible native tool boundary, the same manually submitted response returns the
 * checkpoint through the same Zero Risk request instead.
 */
export function zeroRiskActiveCompactionToolResultInstruction(toolExecuted: boolean): string {
  return [
    `<${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
    toolExecuted
      ? "Codex reached its context limit while this Web response was waiting for the tool result above."
      : "Codex reached its context limit before the requested tool could be sent for execution. The tool was not executed.",
    toolExecuted
      ? "Consume that canonical result, stop ordinary task work now, and do not call any more work tools."
      : "Stop ordinary task work now and do not call any more work tools.",
    COMPACT_PROMPT,
    "Call no more work tools. Return only the complete checkpoint summary to Codex with codex_turn_complete.",
    `</${CODEX_ACTIVE_COMPACTION_REQUEST_MARKER}>`,
  ].join("\n");
}

export function structuredCompactionHandoffInstruction(
  transaction: CompactionTransactionHandle,
  observations: readonly CompactionEvidenceObservation[] = [],
): string {
  return [
    "Automatic Codex context compaction has started. Stop ordinary task work.",
    COMPACT_PROMPT,
    ...compactionEvidenceInstructions(observations),
    ...compactionControlBinding(transaction),
    "Call no other tools. A successful submitted=true response completes the handoff.",
  ].join("\n");
}

export function structuredCompactionRepairInstruction(
  transaction: CompactionTransactionHandle,
  missingInvariants: readonly string[],
  observations: readonly CompactionEvidenceObservation[] = [],
): string {
  return [
    "Repair that draft once. It remains in this conversation.",
    "Missing or invalid items:",
    ...missingInvariants.map((item) => `- ${item}`),
    ...compactionEvidenceInstructions(observations),
    ...compactionControlBinding(transaction),
    "Call no other tools. A successful submitted=true response completes the handoff.",
  ].join("\n");
}

function compactionEvidenceInstructions(observations: readonly CompactionEvidenceObservation[]): string[] {
  if (observations.length === 0) return [];
  return [
    "Bridge observation references from this session. Cite a ref in evidenceRefs only when its completed result and command support the exact claim; failed results may explain blockers. Keep evidence text as well:",
    ...observations.map((observation) => JSON.stringify(observation)),
  ];
}
