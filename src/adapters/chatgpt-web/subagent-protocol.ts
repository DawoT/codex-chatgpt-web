import type { CodexMessage } from "../../types";

export const SUBAGENT_RESULT_TAG_OPEN = "<subagent_result>";
export const SUBAGENT_RESULT_TAG_CLOSE = "</subagent_result>";

export type SubagentResultStatus = "completed" | "failed" | "blocked";

export interface SubagentStructuredResult {
  status: SubagentResultStatus;
  summary: string;
  modified_files?: string[];
  created_artifacts?: string[];
  diagnostics?: string;
}

const VALID_STATUSES = new Set<string>(["completed", "failed", "blocked"]);

/**
 * Parses a structured subagent result from assistant response text.
 * Tolerant to:
 * - XML tags with whitespace or case differences
 * - Markdown ```json ... ``` code fences inside or outside tags
 * - Lenient fallback to raw JSON object if XML tags were omitted
 */
export function parseSubagentStructuredResult(text: string): SubagentStructuredResult | null {
  if (!text || typeof text !== "string") return null;

  // 1. Try finding <subagent_result>...</subagent_result> tags
  const xmlPattern = /<subagent_result>([\s\S]*?)<\/subagent_result>/i;
  const match = xmlPattern.exec(text);

  let rawJson = match ? match[1]?.trim() : undefined;

  // 2. Fallback: if no XML tags, search for a JSON block containing "status" and "summary"
  if (!rawJson) {
    const jsonBlockPattern = /\{[\s\S]*?"status"[\s\S]*?"summary"[\s\S]*?\}/;
    const jsonMatch = jsonBlockPattern.exec(text);
    if (jsonMatch) {
      rawJson = jsonMatch[0].trim();
    }
  }

  if (!rawJson) return null;

  // 3. Strip optional markdown code fences: ```json ... ```
  rawJson = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    // Normalize status
    let status: SubagentResultStatus = "completed";
    if (typeof parsed.status === "string" && VALID_STATUSES.has(parsed.status.toLowerCase())) {
      status = parsed.status.toLowerCase() as SubagentResultStatus;
    } else if (parsed.error || parsed.diagnostics) {
      status = "failed";
    }

    // Normalize summary
    const summary = typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? parsed.summary.trim()
      : typeof parsed.diagnostics === "string" && parsed.diagnostics.trim().length > 0
        ? parsed.diagnostics.trim()
        : "Subagent task finished without description.";

    // Normalize modified_files
    const modifiedFiles = Array.isArray(parsed.modified_files)
      ? (parsed.modified_files as unknown[])
          .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          .map(f => f.trim())
      : undefined;

    // Normalize created_artifacts
    const createdArtifacts = Array.isArray(parsed.created_artifacts)
      ? (parsed.created_artifacts as unknown[])
          .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
          .map(a => a.trim())
      : undefined;

    // Normalize diagnostics
    const diagnostics = typeof parsed.diagnostics === "string" && parsed.diagnostics.trim().length > 0
      ? parsed.diagnostics.trim()
      : typeof parsed.error === "string" && parsed.error.trim().length > 0
        ? parsed.error.trim()
        : undefined;

    return {
      status,
      summary,
      ...(modifiedFiles && modifiedFiles.length > 0 ? { modified_files: modifiedFiles } : {}),
      ...(createdArtifacts && createdArtifacts.length > 0 ? { created_artifacts: createdArtifacts } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Formats a concise, structured representation of a subagent result
 * suitable for embedding in the parent orchestrator's context.
 */
export function formatSubagentResultSummary(result: SubagentStructuredResult): string {
  const lines: string[] = [
    `[Subagent Result: ${result.status.toUpperCase()}]`,
    `Summary: ${result.summary}`,
  ];
  if (result.modified_files && result.modified_files.length > 0) {
    lines.push(`Modified files (${result.modified_files.length}): ${result.modified_files.join(", ")}`);
  }
  if (result.created_artifacts && result.created_artifacts.length > 0) {
    lines.push(`Artifacts (${result.created_artifacts.length}): ${result.created_artifacts.join(", ")}`);
  }
  if (result.diagnostics) {
    lines.push(`Diagnostics: ${result.diagnostics}`);
  }
  return lines.join("\n");
}

/**
 * Instruction template injected into subagent orchestration prompts.
 */
export const SUBAGENT_STRUCTURED_RESULT_SCHEMA_INSTRUCTION = [
  "STRUCTURED RESULT CONTRACT: You must end your final answer with a machine-readable <subagent_result> JSON block matching this exact schema:",
  SUBAGENT_RESULT_TAG_OPEN,
  JSON.stringify({
    status: "completed",
    summary: "Brief 1-3 sentence summary of completed work",
    modified_files: ["path/to/modified-file.ts"],
    created_artifacts: ["path/to/artifact.log"],
    diagnostics: "Error details if failed or blocked (omit if completed)",
  }, null, 2),
  SUBAGENT_RESULT_TAG_CLOSE,
  "Rules:",
  "1. The status must be 'completed', 'failed', or 'blocked'.",
  "2. Keep the summary concise (under 3 sentences).",
  "3. List all files modified during this turn in 'modified_files'.",
  "4. Do not omit the <subagent_result> opening or closing tags.",
];

export interface TrimDeepSubagentHistoryOptions {
  retainRecentCount?: number;
}

/**
 * Trims verbose intermediate dialogue and replaces earlier completed subagent task traces
 * with concise summaries, preserving the latest subagent interactions intact.
 */
export function trimDeepSubagentHistory(
  messages: readonly CodexMessage[],
  options?: TrimDeepSubagentHistoryOptions,
): CodexMessage[] {
  const retainRecentCount = options?.retainRecentCount ?? 2;

  const subagentResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      const text = msg.content
        .filter(p => p.type === "text")
        .map(p => (p.type === "text" ? p.text : ""))
        .join("\n");
      if (parseSubagentStructuredResult(text)) {
        subagentResultIndices.push(i);
      }
    }
  }

  if (subagentResultIndices.length <= retainRecentCount) {
    return [...messages];
  }

  const firstRetainedResultIdx = subagentResultIndices[subagentResultIndices.length - retainRecentCount]!;
  let cutoffIndex = firstRetainedResultIdx;
  while (cutoffIndex > 0 && messages[cutoffIndex - 1]?.role === "agentMessage") {
    cutoffIndex -= 1;
  }

  return messages.map((message, index) => {
    if (index >= cutoffIndex) {
      return message;
    }

    if (message.role === "assistant") {
      let changed = false;
      const condensedContent = message.content.map(part => {
        if (part.type !== "text") return part;
        const res = parseSubagentStructuredResult(part.text);
        if (res) {
          changed = true;
          return { ...part, text: formatSubagentResultSummary(res) };
        }
        return part;
      });
      return changed ? { ...message, content: condensedContent } : message;
    }

    if (message.role === "agentMessage") {
      const rawContent = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map(p => (p.type === "text" ? p.text : "")).join("\n")
          : "";
      if (rawContent.length > 200) {
        const target = message.recipient ? `to ${message.recipient}` : message.author ? `from ${message.author}` : "worker";
        return {
          ...message,
          content: `[Historical subagent task dialogue ${target}: completed in earlier turn (${rawContent.length.toLocaleString("en-US")} chars)]`,
        };
      }
    }

    return message;
  });
}
