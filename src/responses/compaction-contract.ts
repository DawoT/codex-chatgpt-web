/** Internal checkpoint contract shared by first requests and the single bounded repair. */
export function compactionCheckpointInstruction(originalRequestRef?: string): string {
  const reference = originalRequestRef ?? "<copy the authoritative bridge sha256 reference supplied with this request>";
  return [
    "Codex is compacting this conversation. Stop ordinary task work and return a faithful handoff for the next model.",
    "Return exactly one unfenced <compaction_state> block using the following v2 sections. Replace angle-bracket descriptions with observed task data; retain every section.",
    "Preserve pending requirements, original and latest requests, tool outcomes, decisions, blockers, and exactly one next action. Keep prior requirement IDs stable; add IDs for new requirements.",
    "Never invent evidence, completed work, requirements, hashes, or verification. Unknown or unexecuted work stays pending or blocked. Only observed successful results justify verified status.",
    "Use JSON objects on requirement lines with id, status (pending/blocked/verified), and literal source. Verified items also require evidence and supporting supplied evidenceRefs. Use - None for genuinely empty optional lists.",
    "The schema below is a format guide, not task evidence. Do not copy its descriptive placeholders into the checkpoint.",
    "<compaction_state>",
    "version: 2",
    `original_request_ref: ${reference}`,
    "modified_files:",
    "- <observed modified path, or None>",
    "active_hypothesis: <current task objective and working hypothesis>",
    "requirements:",
    '- {"id":"<stable ID>","status":"pending","source":"<literal user requirement>"}',
    "closure_criteria:",
    "- <actual required final check or acceptance criterion>",
    "verified_achievements:",
    "- None",
    "decisions_and_invariants:",
    "- <actual decision or invariant, or None>",
    "blockers_or_test_failures:",
    "- <observed unresolved error, or None>",
    "pending_obligations:",
    "- <unfinished requirement or check, or None>",
    "next_actions:",
    "- <one concrete next action consistent with the latest user request>",
    "</compaction_state>",
    "Place necessary continuation detail outside the block. Preserve code, paths, IDs, quoted strings, and evidence literally. The bridge appends the authoritative original and latest requests; do not forge those appendices.",
  ].join("\n");
}
