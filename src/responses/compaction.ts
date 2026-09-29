import { createHash } from "node:crypto";

/**
 * Remote compaction v2 support for ROUTED providers.
 *
 * Codex decides "this provider supports remote compaction" by provider name (built-in `OpenAI`),
 * and Design B points that provider at this proxy — so Codex sends remote compaction v2 requests
 * for EVERY routed model. The request is a normal /responses call whose input ends with
 * `{"type":"compaction_trigger"}`; codex-rs `collect_compaction_output` then requires the stream
 * to carry EXACTLY ONE `{"type":"compaction","encrypted_content":...}` output item
 * (compact_remote_v2.rs) or it fatals with "expected exactly one compaction output item".
 *
 * Routed models cannot produce OpenAI's encrypted blob, so the proxy runs the model as a plain
 * summarizer and wraps the summary text in a transparent envelope: `ocx1:` + base64(utf8 summary).
 * Codex stores the item and replays it in later input; the parser decodes our envelope back into
 * plain text for routed models. Real OpenAI-encrypted blobs (no `ocx1:` prefix) are opaque —
 * routed models get a short "history was compacted" note instead.
 */

export const BRIDGE_COMPACTION_PREFIX = "ocx1:";

export const COMPACTION_STATE_TAG_START = "<compaction_state>";
export const COMPACTION_STATE_TAG_END = "</compaction_state>";
export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";
export const ORIGINAL_USER_REQUEST_MARKER = "CODEX_ORIGINAL_USER_REQUEST_JSON";

/** Exclude trusted replay appendices when judging what the model actually generated. */
export function compactionDraftText(summary: string): string {
  const latestMarker = `\n\n${LATEST_USER_PROMPT_MARKER}\n`;
  const latestOffset = summary.lastIndexOf(latestMarker);
  if (latestOffset < 0) return summary;
  try {
    if (typeof JSON.parse(summary.slice(latestOffset + latestMarker.length)) !== "string") return summary;
  } catch {
    return summary;
  }

  const beforeLatest = summary.slice(0, latestOffset);
  const originalMarker = `\n\n${ORIGINAL_USER_REQUEST_MARKER}\n`;
  const originalOffset = beforeLatest.lastIndexOf(originalMarker);
  if (originalOffset < 0) return beforeLatest;
  try {
    const record: unknown = JSON.parse(beforeLatest.slice(originalOffset + originalMarker.length));
    if (!record || typeof record !== "object" || Array.isArray(record)) return beforeLatest;
    const { text, sha256 } = record as { text?: unknown; sha256?: unknown };
    if (typeof text !== "string" || typeof sha256 !== "string"
      || createHash("sha256").update(text).digest("hex") !== sha256) return beforeLatest;
  } catch {
    return beforeLatest;
  }
  return beforeLatest.slice(0, originalOffset);
}

export interface CompactionRequirement {
  id: string;
  status: "pending" | "blocked" | "verified";
  source: string;
  evidence?: string;
  evidenceRefs?: string[];
}

export interface CompactionAchievement {
  result: string;
  evidence: string;
  evidenceRefs?: string[];
}

function outsideInlineCode(line: string, index: number): boolean {
  let activeTicks = 0;
  for (let cursor = 0; cursor < index;) {
    if (line[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (line[end] === "`") end += 1;
    const ticks = end - cursor;
    activeTicks = activeTicks === 0 ? ticks : activeTicks === ticks ? 0 : activeTicks;
    cursor = end;
  }
  return activeTicks === 0;
}

/**
 * Normalizes raw or collapsed compaction state blocks, restoring standalone line breaks,
 * unescaping markdown-escaped field names/underscores, and separating inline list bullets.
 */
export function normalizeCompactionStateBlock(raw: string): string {
  const openRegex = /<compaction(?:_|\\_)state(?:\s[^>]*)?>/gi;
  let openMatch: RegExpExecArray | null = null;
  while ((openMatch = openRegex.exec(raw)) !== null) {
    if (outsideInlineCode(raw, openMatch.index)) break;
  }
  if (!openMatch) return raw;

  const closeRegex = /<\/compaction(?:_|\\_)state\s*>/gi;
  closeRegex.lastIndex = openMatch.index + openMatch[0].length;
  let closeMatch: RegExpExecArray | null = null;
  while ((closeMatch = closeRegex.exec(raw)) !== null) {
    if (outsideInlineCode(raw, closeMatch.index)) break;
  }
  if (!closeMatch) return raw;

  const openTag = openMatch[0];
  const closeTag = closeMatch[0];
  const openIdx = openMatch.index;
  const closeIdx = closeMatch.index;

  const before = raw.slice(0, openIdx);
  let inner = raw.slice(openIdx + openTag.length, closeIdx);
  const after = raw.slice(closeIdx + closeTag.length);

  inner = inner.replace(/\\_/g, "_");

  const insideQuote = new Uint8Array(inner.length);
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    insideQuote[index] = quoted ? 1 : 0;
    if (escaped) {
      escaped = false;
    } else if (inner[index] === "\\" && quoted) {
      escaped = true;
    } else if (inner[index] === '"') {
      quoted = !quoted;
    }
  }

  const boundaryPattern = /(?:^|\s+)(?:[-*•]\s+)?(?:#{1,4}\s*)?(?:\*{1,2}|_{1,2})?(version|original[_-]request[_-]ref|modified[_-]files|active[_-]hypothesis|requirements|closure[_-]criteria|verified[_-]achievements|decisions[_-]and[_-]invariants|blockers[_-]or[_-]test[_-]failures|blockers|pending[_-]obligations|next[_-]actions?)(?:\*{1,2}|_{1,2})?\s*:|\s+([-*•]\s+)/gi;
  let currentField = "";
  inner = inner.replace(boundaryPattern, (match, header: string | undefined, bullet: string | undefined, index: number) => {
    if (insideQuote[index]) return match;
    if (header) {
      currentField = header.toLowerCase().replace(/-/g, "_");
      return `\n${currentField}:`;
    }
    if (currentField === "version" || currentField === "original_request_ref"
      || currentField === "active_hypothesis") return match;
    return `\n${bullet}`;
  });

  const cleanInner = inner.trim();
  const prefix = before ? (before.endsWith("\n") ? before : before + "\n") : "";
  const suffix = after ? (after.startsWith("\n") ? after : "\n" + after) : "";

  return `${prefix}<compaction_state>\n${cleanInner}\n</compaction_state>${suffix}`;
}

function checkpointField(line: string): { name: string; value: string } | null {
  const match = /^(?:[-*]\s+)?(?:#{1,4}\s*)?(?:(\*\*|__)([a-z][a-z_\\-]*)\1|([a-z][a-z_\\-]*))\s*:\s*(.*)$/i.exec(line.trim());
  return match
    ? { name: (match[2] ?? match[3])!.replace(/\\_/g, "_").toLowerCase(), value: match[4]! }
    : null;
}

/** Field presence is derived from the same syntax accepted by the parser. */
export function compactionStateFields(summary: string): Set<string> {
  const normalized = normalizeCompactionStateBlock(summary);
  const bounds = locateCompactionStateBounds(normalized);
  const text = bounds ? normalized.slice(bounds.openingEnd, bounds.closingStart) : normalized;
  return new Set(text.split(/\r?\n/).flatMap(line => {
    const field = checkpointField(line);
    return field ? [field.name] : [];
  }));
}

/** Ignore fenced examples when an active unfenced block exists. */
export function countActiveCompactionStates(summary: string): number {
  let rest = summary;
  let count = 0;
  const unfenced = locateCompactionStateBounds(summary, { unfencedOnly: true }) !== null;
  const standaloneOpening = new RegExp(`^\\s*${PERMISSIVE_OPENING_TAG.source}\\s*$`, "i");
  while (true) {
    const bounds = locateCompactionStateBounds(rest, { unfencedOnly: unfenced });
    if (!bounds) break;
    count += 1;
    count += rest.slice(bounds.openingEnd, bounds.closingStart)
      .split(/\r?\n/).filter(line => standaloneOpening.test(line)).length;
    rest = rest.slice(bounds.endTagEnd);
  }
  return count;
}

export interface CompactionStateBlock {
  version?: number;
  originalRequestRef?: string;
  modifiedFiles: string[];
  activeHypothesis?: string;
  requirements?: CompactionRequirement[];
  closureCriteria?: string[];
  verifiedAchievements?: Array<string | CompactionAchievement>;
  decisionsAndInvariants?: string[];
  blockersOrTestFailures: string[];
  pendingObligations?: string[];
  nextActions: string[];
}

/** Native compact.rs consumes an assistant message; compact_remote_v2 consumes a compaction item. */
export function isNativeTextCompaction(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const client = (body as Record<string, unknown>).client_metadata;
  if (!client || typeof client !== "object" || Array.isArray(client)) return false;
  let metadata: unknown = (client as Record<string, unknown>)["x-codex-turn-metadata"];
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { return false; }
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const request = metadata as Record<string, unknown>;
  if (request.request_kind !== "compaction") return false;
  const protocol = request.compaction as Record<string, unknown> | undefined;
  if (!protocol || protocol.implementation !== "responses" || protocol.strategy !== "memento") {
    throw new Error("Unsupported native text compaction protocol; expected responses/memento");
  }
  return true;
}

/** Mirrors codex-rs core/templates/compact/prompt.md (the local-compaction instruction). */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- The current objective and working hypothesis
- Verified achievements only, each paired with concrete evidence (tests, file state, command output, or other observable proof)
- Key decisions and invariants that must remain true
- Blockers, failed attempts, failed tests, and unresolved diagnostics
- Pending obligations and one clear next action
- Modified files and references needed to continue

Do not convert attempts into achievements. A step is a verified achievement only when the source conversation contains observable evidence that it completed successfully. Preserve unresolved failures and obligations even when they are inconvenient or repetitive.
Deduplicate repeated state. Replace long tool output with a precise, recoverable source reference and the observed result; do not silently drop evidence.

STRUCTURED HANDOFF REQUIREMENT:
At the beginning or end of your summary, include a <compaction_state> XML block:
Do not wrap the <compaction_state> block in a Markdown code fence or inline backticks. The opening and closing tags must be literal standalone lines.
<compaction_state>
version: 2
original_request_ref: Exact reference to the original user request.
modified_files:
- path/to/modified_file1
- path/to/modified_file2
active_hypothesis: One concise sentence describing the current working hypothesis or task goal.
requirements:
- {"id":"REQ-1","status":"pending","source":"original user request: exact requirement"}
- {"id":"REQ-2","status":"verified","source":"original user request: exact requirement","evidence":"observable successful result from source conversation"}
closure_criteria:
- Criterion that proves the mission is complete
verified_achievements:
- Achievement — evidence: exact test, command, file state, or observation proving it
decisions_and_invariants:
- Decision or invariant that must survive the handoff
blockers_or_test_failures:
- Specific failed test or blocker (or None)
pending_obligations:
- Unfinished requirement or follow-up that must not be dropped
next_actions:
- The single best concrete next action
</compaction_state>

Be concise, structured, and focused on helping the next LLM seamlessly continue the work without losing file paths or test state.`;

/** Mirrors codex-rs core/templates/compact/summary_prefix.md (framing for a replayed summary). */
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";

/** Codex v1 uses one newline after the prefix; the transparent v2 replay uses two. */
export function isReadableCompactionSummaryText(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${SUMMARY_PREFIX}\n`);
}

export function encodeCompactionSummary(summary: string): string {
  return BRIDGE_COMPACTION_PREFIX + Buffer.from(summary, "utf-8").toString("base64");
}

/** Decode an `ocx1:` envelope; returns null for real (OpenAI-encrypted) blobs or garbage. */
export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(BRIDGE_COMPACTION_PREFIX)) return null;
  const encoded = encryptedContent.slice(BRIDGE_COMPACTION_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== encoded) return null;
    const summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(summary, "utf-8").equals(bytes) && summary.trim() ? summary : null;
  } catch {
    return null;
  }
}

export const PERMISSIVE_OPENING_TAG = /(?:(?:<|&lt;)\s*compaction(?:\_|\-|\\[_\-])+state\s*(?:>|&gt;))/i;
export const PERMISSIVE_CLOSING_TAG = /(?:(?:<|&lt;)\s*\/\s*compaction(?:\_|\-|\\[_\-])+state\s*(?:>|&gt;))/i;

export interface CompactionStateBounds {
  startTagStart: number;
  openingEnd: number;
  closingStart: number;
  endTagEnd: number;
  fenced?: boolean;
}


export function locateCompactionStateBounds(
  summary: string,
  options?: { unfencedOnly?: boolean },
): CompactionStateBounds | null {
  let startTagStart = -1;
  let openingEnd = -1;
  let fence: { marker: string; length: number } | undefined;
  const sourceLines = summary.split("\n");
  let offset = 0;

  // Pass 1: unfenced strict match (<compaction_state> and </compaction_state> outside fences)
  for (const line of sourceLines) {
    const fenceRun = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenceRun?.[0] === fence.marker && fenceRun.length >= fence.length
        && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = undefined;
      }
    } else if (fenceRun) {
      fence = { marker: fenceRun[0]!, length: fenceRun.length };
    } else {
      if (startTagStart < 0) {
        const index = line.indexOf(COMPACTION_STATE_TAG_START);
        if (index >= 0 && outsideInlineCode(line, index)) {
          startTagStart = offset + index;
          openingEnd = startTagStart + COMPACTION_STATE_TAG_START.length;
        }
      }
      const searchFrom = Math.max(0, openingEnd - offset);
      const index = startTagStart >= 0 ? line.indexOf(COMPACTION_STATE_TAG_END, searchFrom) : -1;
      if (index >= 0 && outsideInlineCode(line, index)) {
        const closingStart = offset + index;
        return {
          startTagStart,
          openingEnd,
          closingStart,
          endTagEnd: closingStart + COMPACTION_STATE_TAG_END.length,
          fenced: false,
        };
      }
    }
    offset += line.length + 1;
  }

  // Pass 2: unfenced permissive match (escaped/entity tags outside fences)
  fence = undefined;
  offset = 0;
  startTagStart = -1;
  openingEnd = -1;

  for (const line of sourceLines) {
    const fenceRun = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenceRun?.[0] === fence.marker && fenceRun.length >= fence.length
        && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = undefined;
      }
    } else if (fenceRun) {
      fence = { marker: fenceRun[0]!, length: fenceRun.length };
    } else {
      if (startTagStart < 0) {
        const match = PERMISSIVE_OPENING_TAG.exec(line);
        if (match && outsideInlineCode(line, match.index)) {
          startTagStart = offset + match.index;
          openingEnd = startTagStart + match[0].length;
        }
      }
      if (startTagStart >= 0) {
        const searchOffset = Math.max(0, openingEnd - offset);
        const remainingInLine = line.slice(searchOffset);
        const match = PERMISSIVE_CLOSING_TAG.exec(remainingInLine);
        if (match && outsideInlineCode(line, searchOffset + match.index)) {
          const closingStart = offset + searchOffset + match.index;
          return {
            startTagStart,
            openingEnd,
            closingStart,
            endTagEnd: closingStart + match[0].length,
            fenced: false,
          };
        }
      }
    }
    offset += line.length + 1;
  }

  if (options?.unfencedOnly) return null;

  // Pass 3: fenced permissive match (model wrapped entire checkpoint in markdown code fence)
  offset = 0;
  startTagStart = -1;
  openingEnd = -1;

  for (const line of sourceLines) {
    if (startTagStart < 0) {
      const match = PERMISSIVE_OPENING_TAG.exec(line);
      if (match && outsideInlineCode(line, match.index)) {
        startTagStart = offset + match.index;
        openingEnd = startTagStart + match[0].length;
      }
    }
    if (startTagStart >= 0) {
      const searchOffset = Math.max(0, openingEnd - offset);
      const remainingInLine = line.slice(searchOffset);
      const match = PERMISSIVE_CLOSING_TAG.exec(remainingInLine);
      if (match && outsideInlineCode(line, searchOffset + match.index)) {
        const closingStart = offset + searchOffset + match.index;
        return {
          startTagStart,
          openingEnd,
          closingStart,
          endTagEnd: closingStart + match[0].length,
          fenced: true,
        };
      }
    }
    offset += line.length + 1;
  }

  return null;
}

/** Safe, content-free diagnostics for distinguishing omitted tags from Markdown fencing. */
export function inspectCompactionStateFormat(summary: string): {
  openingTags: number;
  closingTags: number;
  usableUnfencedBlock: boolean;
  fencedTag: boolean;
} {
  let fencedTag = false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of summary.split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (PERMISSIVE_OPENING_TAG.test(line) || PERMISSIVE_CLOSING_TAG.test(line)) {
        fencedTag = true;
      }
      if (run?.[0] === fence.marker && run.length >= fence.length
        && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = undefined;
      }
    } else if (run) {
      fence = { marker: run[0]!, length: run.length };
    }
  }
  const countOpening = (summary.match(new RegExp(PERMISSIVE_OPENING_TAG.source, "gi")) ?? []).length;
  const countClosing = (summary.match(new RegExp(PERMISSIVE_CLOSING_TAG.source, "gi")) ?? []).length;
  return {
    openingTags: countOpening,
    closingTags: countClosing,
    usableUnfencedBlock: locateCompactionStateBounds(summary, { unfencedOnly: true }) !== null,
    fencedTag,
  };
}

function parseCompactionStateLines(rawBlock: string): CompactionStateBlock {
  const lines = rawBlock.split(/\r?\n/).map(line => line.trim());

  const modifiedFiles: string[] = [];
  const requirements: CompactionRequirement[] = [];
  const closureCriteria: string[] = [];
  const verifiedAchievements: Array<string | CompactionAchievement> = [];
  const decisionsAndInvariants: string[] = [];
  const blockersOrTestFailures: string[] = [];
  const pendingObligations: string[] = [];
  const nextActions: string[] = [];
  let activeHypothesis: string | undefined;
  let version: number | undefined;
  let originalRequestRef: string | undefined;

  let currentSection:
    | "modified_files"
    | "requirements"
    | "closure_criteria"
    | "verified_achievements"
    | "decisions_and_invariants"
    | "blockers"
    | "pending_obligations"
    | "next_actions"
    | "none" = "none";

  for (const line of lines) {
    if (!line) continue;
    const field = checkpointField(line);
    const name = field?.name;
    const value = field?.value ?? "";

    if (name === "version") {
      currentSection = "none";
      version = Number(value.trim());
      continue;
    }
    if (name === "original_request_ref") {
      currentSection = "none";
      originalRequestRef = value.trim();
      continue;
    }
    if (name === "modified_files") {
      currentSection = "modified_files";
      continue;
    }
    if (name === "active_hypothesis") {
      currentSection = "none";
      const rest = value.trim();
      if (rest) activeHypothesis = rest;
      continue;
    }
    if (name === "requirements") {
      currentSection = "requirements";
      continue;
    }
    if (name === "closure_criteria") {
      currentSection = "closure_criteria";
      continue;
    }
    if (name === "verified_achievements") {
      currentSection = "verified_achievements";
      continue;
    }
    if (name === "decisions_and_invariants") {
      currentSection = "decisions_and_invariants";
      continue;
    }
    if (name === "blockers_or_test_failures" || name === "blockers") {
      currentSection = "blockers";
      continue;
    }
    if (name === "pending_obligations") {
      currentSection = "pending_obligations";
      continue;
    }
    if (name === "next_actions" || name === "next_steps") {
      currentSection = "next_actions";
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      const item = line.slice(2).trim();
      if (!item || item.toLowerCase() === "none" || item.toLowerCase() === "none.") continue;
      if (currentSection === "modified_files") {
        modifiedFiles.push(item);
      } else if (currentSection === "requirements") {
        try {
          const parsed: unknown = JSON.parse(item);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            requirements.push(parsed as CompactionRequirement);
          }
        } catch {
          requirements.push({ id: "", status: "pending", source: item });
        }
      } else if (currentSection === "closure_criteria") {
        closureCriteria.push(item);
      } else if (currentSection === "verified_achievements") {
        if (item.startsWith("{")) {
          try {
            const achievement: unknown = JSON.parse(item);
            if (achievement && typeof achievement === "object" && !Array.isArray(achievement)) {
              verifiedAchievements.push(achievement as CompactionAchievement);
            } else {
              verifiedAchievements.push(item);
            }
          } catch {
            verifiedAchievements.push(item);
          }
        } else {
          verifiedAchievements.push(item);
        }
      } else if (currentSection === "decisions_and_invariants") {
        decisionsAndInvariants.push(item);
      } else if (currentSection === "blockers") {
        blockersOrTestFailures.push(item);
      } else if (currentSection === "pending_obligations") {
        pendingObligations.push(item);
      } else if (currentSection === "next_actions") {
        nextActions.push(item);
      }
    } else {
      currentSection = "none";
    }
  }

  return {
    ...(version !== undefined ? { version } : {}),
    ...(originalRequestRef ? { originalRequestRef } : {}),
    modifiedFiles,
    ...(activeHypothesis ? { activeHypothesis } : {}),
    ...(version !== undefined || requirements.length > 0 ? { requirements } : {}),
    ...(version !== undefined || closureCriteria.length > 0 ? { closureCriteria } : {}),
    ...(verifiedAchievements.length > 0 ? { verifiedAchievements } : {}),
    ...(decisionsAndInvariants.length > 0 ? { decisionsAndInvariants } : {}),
    blockersOrTestFailures,
    ...(pendingObligations.length > 0 ? { pendingObligations } : {}),
    nextActions,
  };
}

function withoutFencedExamples(summary: string): string {
  let fence: { marker: string; length: number } | undefined;
  return summary.split(/\r?\n/).map(line => {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (run?.[0] === fence.marker && run.length >= fence.length
        && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) {
        fence = undefined;
      }
      return "";
    }
    if (run) {
      fence = { marker: run[0]!, length: run.length };
      return "";
    }
    if (/^(?: {4,}|\t)/.test(line)) return "";
    return line;
  }).join("\n");
}

/** Count all listed requirements, including items the parser cannot represent. */
export function countCompactionRequirementItems(summary: string): number {
  const normalized = normalizeCompactionStateBlock(summary);
  const bounds = locateCompactionStateBounds(normalized);
  const text = bounds
    ? normalized.slice(bounds.openingEnd, bounds.closingStart)
    : withoutFencedExamples(normalized);
  let inRequirements = false;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const field = checkpointField(line);
    if (field) {
      inRequirements = field.name === "requirements";
      continue;
    }
    if (!inRequirements || !line.trim()) continue;
    const item = /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.trim();
    if (!item) {
      inRequirements = false;
    } else if (item.toLowerCase() !== "none" && item.toLowerCase() !== "none.") {
      count += 1;
    }
  }
  return count;
}

function parseTaglessCompactionState(summary: string): CompactionStateBlock | null {
  if (PERMISSIVE_OPENING_TAG.test(summary) || PERMISSIVE_CLOSING_TAG.test(summary)) {
    return null;
  }
  const active = withoutFencedExamples(summary);
  const fields = compactionStateFields(active);
  const hasVersion = fields.has("version");
  const hasRequirements = fields.has("requirements");
  const hasNextActions = fields.has("next_actions") || fields.has("next_steps");

  if (!hasRequirements || !hasNextActions) return null;
  if (!hasVersion) {
    const structuredHeaders = [
      "modified_files", "active_hypothesis", "closure_criteria", "verified_achievements",
      "decisions_and_invariants", "blockers_or_test_failures", "blockers", "pending_obligations",
    ].filter(field => fields.has(field)).length;
    if (structuredHeaders < 2) return null;
  }

  const parsed = parseCompactionStateLines(active);
  if (!parsed.requirements?.length || !parsed.nextActions?.length) return null;
  return parsed;
}

/** Parses a <compaction_state> XML block from summary text, if present. */
export function parseCompactionState(summary: string): CompactionStateBlock | null {
  const normalized = normalizeCompactionStateBlock(summary);
  const bounds = locateCompactionStateBounds(normalized);
  if (bounds) {
    const rawBlock = normalized.slice(bounds.openingEnd, bounds.closingStart).trim();
    return parseCompactionStateLines(rawBlock);
  }
  return parseTaglessCompactionState(normalized);
}

/** Formats a structured state block into canonical XML. */
export function formatCompactionStateBlock(block: CompactionStateBlock): string {
  const parts: string[] = [COMPACTION_STATE_TAG_START];

  if (block.version !== undefined) parts.push(`version: ${block.version}`);
  if (block.originalRequestRef) parts.push(`original_request_ref: ${block.originalRequestRef}`);
  parts.push("modified_files:");
  if (block.modifiedFiles.length === 0) {
    parts.push("- None");
  } else {
    for (const f of block.modifiedFiles) parts.push(`- ${f}`);
  }

  if (block.activeHypothesis) {
    parts.push(`active_hypothesis: ${block.activeHypothesis}`);
  }

  if (block.requirements) {
    parts.push("requirements:");
    if (block.requirements.length === 0) parts.push("- None");
    else for (const requirement of block.requirements) parts.push(`- ${JSON.stringify(requirement)}`);
  }

  if (block.closureCriteria) {
    parts.push("closure_criteria:");
    if (block.closureCriteria.length === 0) parts.push("- None");
    else for (const criterion of block.closureCriteria) parts.push(`- ${criterion}`);
  }

  if (block.verifiedAchievements) {
    parts.push("verified_achievements:");
    if (block.verifiedAchievements.length === 0) parts.push("- None");
    else for (const achievement of block.verifiedAchievements) {
      parts.push(`- ${typeof achievement === "string" ? achievement : JSON.stringify(achievement)}`);
    }
  }

  if (block.decisionsAndInvariants) {
    parts.push("decisions_and_invariants:");
    if (block.decisionsAndInvariants.length === 0) parts.push("- None");
    else for (const decision of block.decisionsAndInvariants) parts.push(`- ${decision}`);
  }

  parts.push("blockers_or_test_failures:");
  if (block.blockersOrTestFailures.length === 0) {
    parts.push("- None");
  } else {
    for (const b of block.blockersOrTestFailures) parts.push(`- ${b}`);
  }

  if (block.pendingObligations) {
    parts.push("pending_obligations:");
    if (block.pendingObligations.length === 0) parts.push("- None");
    else for (const obligation of block.pendingObligations) parts.push(`- ${obligation}`);
  }

  parts.push("next_actions:");
  if (block.nextActions.length === 0) {
    parts.push("- None");
  } else {
    for (const a of block.nextActions) parts.push(`- ${a}`);
  }

  parts.push(COMPACTION_STATE_TAG_END);
  return parts.join("\n");
}

/** Separates narrative summary text from the structured state block. */
export function extractStructuredCompactionHandoff(summary: string): {
  narrative: string;
  state: CompactionStateBlock | null;
} {
  const normalized = normalizeCompactionStateBlock(summary);
  const state = parseCompactionState(normalized);
  if (!state) return { narrative: summary.trim(), state: null };

  const bounds = locateCompactionStateBounds(normalized);
  if (bounds) {
    let before = normalized.slice(0, bounds.startTagStart).trim();
    let after = normalized.slice(bounds.endTagEnd).trim();
    if (bounds.fenced) {
      before = before.replace(/\n? {0,3}(?:`{3,}|~{3,})[^\n]*$/, "").trim();
      after = after.replace(/^ {0,3}(?:`{3,}|~{3,})\s*\n?/, "").trim();
    }
    const narrative = [before, after].filter(Boolean).join("\n\n");
    return { narrative, state };
  }

  // Tagless structured checkpoint
  const lines = normalized.split(/\r?\n/);
  const structuredHeaders = new Set([
    "version", "original_request_ref", "modified_files", "active_hypothesis", "requirements",
    "closure_criteria", "verified_achievements", "decisions_and_invariants", "blockers_or_test_failures",
    "blockers", "pending_obligations", "next_actions", "next_steps",
  ]);
  let firstStructuredLine = -1;
  let lastStructuredLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (structuredHeaders.has(checkpointField(line)?.name ?? "")) {
      if (firstStructuredLine < 0) firstStructuredLine = i;
      lastStructuredLine = i;
    } else if (firstStructuredLine >= 0 && (line.startsWith("- ") || line.startsWith("* "))) {
      lastStructuredLine = i;
    }
  }

  const before = firstStructuredLine > 0 ? lines.slice(0, firstStructuredLine).join("\n").trim() : "";
  const after = lastStructuredLine >= 0 && lastStructuredLine < lines.length - 1 ? lines.slice(lastStructuredLine + 1).join("\n").trim() : "";
  const narrative = [before, after].filter(Boolean).join("\n\n");
  return { narrative, state };
}

/** Render a replayed compaction item as plain user-visible text for a routed model. */
export function compactionItemToText(encryptedContent: string | undefined): string {
  const decoded = typeof encryptedContent === "string" ? decodeCompactionSummary(encryptedContent) : null;
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

/**
 * Remote compaction v1 (`POST /responses/compact`, unary) — codex-rs installs the returned
 * `{"output":[ResponseItem...]}` as the REPLACEMENT history (compact_remote.rs
 * process_compacted_history). Mirror codex-rs local `build_compacted_history`: recent real user
 * messages within a token budget, then one user message `SUMMARY_PREFIX\n<summary>`. Plain user
 * message items parse as real user messages on the codex side (event_mapping parse_user_message);
 * contextual wrappers are filtered there, and v2-style `compaction` items are NOT expected here.
 */

/** codex-rs compact.rs COMPACT_USER_MESSAGE_MAX_TOKENS = 20k tokens (~4 chars/token). */
const COMPACT_V1_RETAINED_CHAR_BUDGET = 20_000 * 4;

type CompactMessageItem = Record<string, unknown>;

interface CompactContentBlock extends Record<string, unknown> {
  type?: string;
  text?: string;
  image_url?: string;
}

/**
 * Codex can persist unavailable historical images as a one-pixel PNG. Replaying that sentinel as
 * a real attachment produces an opaque black tile in ChatGPT and consumes one attachment slot,
 * but carries no visual information. Treat every 1x1 PNG data URL as non-semantic transport state.
 */
export function isOnePixelPngDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) return false;
  try {
    const png = Buffer.from(value.slice("data:image/png;base64,".length), "base64");
    return png.length >= 24
      && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && png.readUInt32BE(16) === 1
      && png.readUInt32BE(20) === 1;
  } catch {
    return false;
  }
}

/**
 * Extract original user message items from a Responses `input` array.
 *
 * Keeping the original item metadata matters: Codex uses it after `/responses/compact` to
 * distinguish real user turns from contextual user-role wrappers. Images remain structured
 * `input_image` blocks so the browser adapter can upload them as attachments; their data URL is
 * never copied into the textual ChatGPT transport envelope.
 */
export function extractCompactUserMessages(input: unknown): CompactMessageItem[] {
  if (!Array.isArray(input)) return [];
  const out: CompactMessageItem[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as CompactMessageItem & { type?: string; role?: string; content?: unknown };
    if (rec.type !== undefined && rec.type !== "message") continue;
    if (rec.role !== "user") continue;
    // Codex removes InternalModelContextFragment during process_annotated_compacted_history.
    // In particular, a goal continuation is runtime steering, not a retained human message.
    // Exclude it before computing the v1 checkpoint source, or the next request authenticates
    // against a message that native Codex has already discarded.
    if (compactContentBlocks(rec).some(block => textBlock(block) && (
      /^<codex_internal_context source="[a-z][a-z0-9_]*">[\s\S]*<\/codex_internal_context>$/.test(block.text!.trim())
      || /^<goal_context>[\s\S]*<\/goal_context>$/.test(block.text!.trim())
    ))) continue;
    if (isReadableCompactionSummaryText(
      compactContentBlocks(rec).filter(textBlock).map(block => block.text).join(""),
    )) continue;
    out.push(structuredClone(rec));
  }
  return out;
}

function compactUserMessageItem(text: string): CompactMessageItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function compactContentBlocks(item: CompactMessageItem): CompactContentBlock[] {
  if (typeof item.content === "string") {
    return [{ type: "input_text", text: item.content }];
  }
  if (!Array.isArray(item.content)) return [];
  return item.content
    .filter((block): block is CompactContentBlock => Boolean(block && typeof block === "object" && !Array.isArray(block)))
    .map(block => structuredClone(block));
}

function textBlock(block: CompactContentBlock): boolean {
  return (block.type === "input_text" || block.type === "text") && typeof block.text === "string";
}

function imageBlock(block: CompactContentBlock): boolean {
  return block.type === "input_image"
    && typeof block.image_url === "string"
    && !isOnePixelPngDataUrl(block.image_url);
}

/**
 * Build the v1 compact replacement history.
 *
 * Text follows Codex's 20k-token retained-user-message budget. Image history is independently
 * bounded to ChatGPT's ten-attachment limit, newest first. This prevents an old image corpus from
 * immediately refilling Codex's context window after a successful compact while still preserving
 * the visual context the browser model can actually receive.
 */
export function buildCompactV1Output(
  userMessages: CompactMessageItem[],
  summary: string,
  maxImages = 10,
): CompactMessageItem[] {
  const selected: CompactMessageItem[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  let retainedImages = 0;
  for (let i = userMessages.length - 1; i >= 0 && (remaining > 0 || retainedImages < maxImages); i--) {
    const message = structuredClone(userMessages[i]!);
    const blocks = compactContentBlocks(message);
    const retainedReversed: CompactContentBlock[] = [];
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      if (imageBlock(block)) {
        if (retainedImages < maxImages) {
          retainedImages += 1;
          retainedReversed.push(block);
        }
        continue;
      }
      if (!textBlock(block) || remaining === 0) continue;
      const text = block.text!;
      if (text.length <= remaining) {
        remaining -= text.length;
        retainedReversed.push({ ...block, type: "input_text", text });
      } else {
        retainedReversed.push({ ...block, type: "input_text", text: text.slice(text.length - remaining) });
        remaining = 0;
      }
    }
    const content = retainedReversed.reverse();
    if (content.length > 0) {
      message.type = "message";
      message.role = "user";
      message.content = content;
      selected.push(message);
    }
  }
  selected.reverse();
  // codex-rs compact.rs uses "{SUMMARY_PREFIX}\n{summary}" (single newline) and detects stored
  // summaries by that exact prefix — keep the same shape.
  const summaryText = summary.trim().length > 0 ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  return [...selected, compactUserMessageItem(summaryText)];
}
