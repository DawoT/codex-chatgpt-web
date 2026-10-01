import { extractStructuredCompactionHandoff } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { validateCompactionQuality } from "./autonomous-compaction";
import { canonicalizeCompactionHandoff } from "./compaction-handoff";

export interface CompactionCheckpointInspection {
  valid: boolean;
  summary: string;
  state: ReturnType<typeof extractStructuredCompactionHandoff>["state"];
  quality: ReturnType<typeof validateCompactionQuality>;
  issues: string[];
  transformations: string[];
}

/** All routes preserve defects for validation instead of filling unknown semantic fields. */
export function inspectCompactionCheckpoint(
  parsed: CodexParsedRequest,
  draft: string,
  evidenceSessionId?: string,
): CompactionCheckpointInspection {
  const summary = canonicalizeCompactionHandoff(parsed, draft.trim() ? draft : "Empty checkpoint draft", {
    strict: true,
  });
  const state = extractStructuredCompactionHandoff(summary).state;
  const quality = validateCompactionQuality(parsed.context.messages, summary, {
    requireStructured: true,
    evidenceSessionId,
  });
  return {
    valid: quality.valid,
    summary,
    state,
    quality,
    issues: [...quality.missingInvariants],
    transformations: summary === draft ? [] : ["syntax_normalization_and_source_appendices"],
  };
}

/** One semantic repair budget for the entire operation, including fallback after retained rescue. */
export class CompactionCheckpointPolicy {
  private repaired = false;

  constructor(
    private readonly parsed: CodexParsedRequest,
    private readonly evidenceSessionId?: string,
  ) {}

  get canRepair(): boolean {
    return !this.repaired;
  }

  inspect(draft: string): CompactionCheckpointInspection {
    return inspectCompactionCheckpoint(this.parsed, draft, this.evidenceSessionId);
  }

  async repair(
    draft: string,
    repair: (issues: readonly string[]) => Promise<string>,
  ): Promise<CompactionCheckpointInspection> {
    const inspection = this.inspect(draft);
    if (inspection.valid || this.repaired) return inspection;
    this.repaired = true;
    return this.inspect(await repair(inspection.issues));
  }
}
