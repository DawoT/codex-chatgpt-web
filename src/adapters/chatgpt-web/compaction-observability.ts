import { emitDiagnosticEvent } from "../../diagnostics";
import {
  extractStructuredCompactionHandoff,
  inspectCompactionStateFormat,
  normalizeCompactionStateBlock,
} from "../../responses/compaction";
import { runtimeIdentity } from "../../runtime-identity";

const CHECKPOINT_FIELDS = new Set([
  "version",
  "original_request_ref",
  "modified_files",
  "active_hypothesis",
  "requirements",
  "closure_criteria",
  "verified_achievements",
  "decisions_and_invariants",
  "blockers_or_test_failures",
  "pending_obligations",
  "next_actions",
]);

/** Reports only allowlisted structure; no checkpoint values or source paths leave this function. */
export function checkpointStructuralDiagnostic(draft: string) {
  const normalized = normalizeCompactionStateBlock(draft);
  const opening = /<compaction_state(?:\s[^>]*)?>/i.exec(normalized);
  const closing = opening ? /<\/compaction_state\s*>/i.exec(normalized.slice(opening.index + opening[0].length)) : null;
  const fieldText = opening
    ? normalized.slice(
        opening.index + opening[0].length,
        closing ? opening.index + opening[0].length + closing.index : undefined,
      )
    : normalized;
  const recognizedFields = [
    ...new Set(
      fieldText.split(/\r?\n/).flatMap((line) => {
        const name = /^\s*([a-z_]+)\s*:/i.exec(line)?.[1]?.toLowerCase();
        return name && CHECKPOINT_FIELDS.has(name) ? [name] : [];
      }),
    ),
  ];
  const state = extractStructuredCompactionHandoff(normalized).state;
  return {
    ...inspectCompactionStateFormat(normalized),
    recognizedFields,
    version: state?.version ?? null,
    requirementCount: state?.requirements?.length ?? 0,
    modifiedFileCount: state?.modifiedFiles.length ?? 0,
  };
}

export type CompactionPhase =
  | "prepared"
  | "received"
  | "validated"
  | "repair_started"
  | "persisted"
  | "accepted"
  | "delivered"
  | "failed";

export type CompactionRoute = "retained" | "fallback" | "fresh" | "unknown";

export interface CompactionEvent {
  traceId: string;
  handoffTraceId?: string;
  phase: CompactionPhase;
  outcome: "pending" | "succeeded" | "skipped" | "rejected" | "failed";
  route: CompactionRoute;
  attempt?: number;
  elapsedMs?: number;
  reasonCode?: string;
  issueCodes?: string[];
  localPersisted?: boolean;
  requirementCount?: number;
  error?: unknown;
}

const ISSUE_PATTERNS: Array<[RegExp, string]> = [
  [/multiple active compaction state blocks/i, "multiple_active_blocks"],
  [/missing structured compaction state/i, "missing_state"],
  [/mission checklist version 2/i, "missing_version_2"],
  [/duplicate requirement id/i, "duplicate_requirement_id"],
  [/missing .*modified file|missing reference to modified or referenced file/i, "missing_modified_file"],
  [/unknown evidence reference/i, "unknown_evidence_ref"],
  [/unfinished or failed result/i, "unfinished_evidence"],
  [/no completed observation|not a completed observation/i, "missing_completed_observation"],
  [/missing prior requirement/i, "missing_prior_requirement"],
  [/regressed/i, "requirement_regressed"],
  [/changed its source/i, "requirement_source_changed"],
  [/invalid stable id/i, "invalid_requirement_id"],
  [/invalid status/i, "invalid_requirement_status"],
  [/lacks evidence/i, "missing_evidence"],
  [/missing mission requirements/i, "missing_requirements"],
  [/invalid mission requirement item/i, "invalid_requirement"],
  [
    /missing original request reference|original request reference changed|original request reference does not match/i,
    "original_request_ref_invalid",
  ],
  [/one clear next action/i, "invalid_next_action"],
  [/missing closure criteria/i, "missing_closure_criteria"],
  [/missing .* section/i, "missing_section"],
];

/** Issue messages may contain paths, requirement IDs, and model text. Only codes enter logs. */
export function checkpointIssueCodes(issues: readonly string[]): string[] {
  return [
    ...new Set(
      issues.map((issue) => ISSUE_PATTERNS.find(([pattern]) => pattern.test(issue))?.[1] ?? "other_validation_issue"),
    ),
  ].slice(0, 24);
}

/** One JSON object per line; no checkpoint, tool output, source path, token, or raw error. */
export function logCompactionEvent(event: CompactionEvent): void {
  const traceId = /^[a-f0-9]{12}$/.test(event.traceId) ? event.traceId : "unknown";
  const handoffTraceId =
    event.handoffTraceId && /^[a-f0-9]{12}$/.test(event.handoffTraceId) ? event.handoffTraceId : undefined;
  const reasonCode = event.reasonCode && /^[a-z][a-z0-9_]{0,79}$/.test(event.reasonCode) ? event.reasonCode : undefined;
  emitDiagnosticEvent(
    {
      producer: "main",
      event: "compaction_checkpoint",
      phase: event.phase === "failed" ? "failed" : event.phase === "delivered" ? "delivered" : "observed",
      correlation: { traceId, turnId: traceId },
      fields: {
        checkpointPhase: event.phase,
        route: event.route,
        outcome: event.outcome,
        reason: reasonCode,
        attempt: event.attempt,
        elapsedMs: event.elapsedMs,
        issueCount: event.issueCodes?.length,
        localPersisted: event.localPersisted,
        requirementCount: event.requirementCount,
      },
      error: event.error,
    },
    { write: () => undefined },
  );
  console.info(
    `[chatgpt-web] compaction_event ${JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      traceId,
      ...(handoffTraceId ? { handoffTraceId } : {}),
      phase: event.phase,
      outcome: event.outcome,
      route: event.route,
      ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      ...(event.elapsedMs !== undefined ? { elapsedMs: Math.max(0, Math.round(event.elapsedMs)) } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(event.issueCodes?.length
        ? {
            issueCodes: event.issueCodes
              .slice(0, 24)
              .map((code) => (/^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "other_validation_issue")),
          }
        : {}),
      ...(event.localPersisted !== undefined ? { localPersisted: event.localPersisted } : {}),
      ...(event.requirementCount !== undefined ? { requirementCount: event.requirementCount } : {}),
      runtime: runtimeIdentity,
    })}`,
  );
}
