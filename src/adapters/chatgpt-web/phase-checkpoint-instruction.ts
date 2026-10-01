import { compactionCheckpointInstruction } from "../../responses/compaction-contract";
import type { CodexParsedRequest } from "../../types";
import { compactionOriginalRequestRef } from "./compaction-source";

export function phaseCheckpointInstruction(parsed: CodexParsedRequest): string {
  const schema = compactionCheckpointInstruction(compactionOriginalRequestRef(parsed)).split("\n").slice(1).join("\n");
  return [
    "At the end of a substantial work phase, before your final response, submit a durable checkpoint through Codex Native codex_tool_call with wire_name codex.control.phase_checkpoint and arguments {summary: <structured checkpoint text>}.",
    "This is a control operation. Do not invent a tool call or stop pending tool work. A checkpoint is confirmed only after your final answer is durably recorded. Continue healthy chats normally; phase boundaries alone do not require a new chat.",
    "Before writing verified claims, read checkpoint_ref current and ref manifest to obtain bridge-supplied observation refs for this phase. Read relevant refs in bounded pages. The schema below applies only to arguments.summary. Your final response still answers the user normally.",
    "Keep essential checkpoint state within 4000 estimated tokens. Preserve every literal user requirement. The bridge stores source and evidence locally; do not copy full transcripts or tool output into the summary. If validation rejects the checkpoint, repair it before ending the phase.",
    "Retrieve omitted evidence with wire_name codex.control.checkpoint_evidence and arguments {checkpoint_ref: <supplied ref>, ref: <original_request|manifest|message:index|evidence ref>, offset: 0, limit: 6000}. Both control operations require the active turn_token.",
    schema,
  ].join("\n");
}
