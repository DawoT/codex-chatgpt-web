import { createHash } from "node:crypto";
import { ORIGINAL_USER_REQUEST_MARKER } from "../../responses/compaction";
import type { CodexMessage } from "../../types";

interface CompactionSource {
  context: { messages: readonly CodexMessage[] };
}

function textContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Resolve provenance only from native source history or a hash-verified trusted replay appendix. */
export function compactionOriginalRequest(parsed: CompactionSource): string | undefined {
  const previous = parsed.context.messages.filter(
    (message) => message.role === "user" && message.origin === "compaction_summary",
  );
  if (previous.length === 0) {
    const candidates = parsed.context.messages.filter(
      (message) => message.role === "user" && message.origin !== "codex_skill",
    );
    const first =
      candidates.find(
        (message) =>
          !/^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(textContent(message.content) ?? ""),
      ) ?? candidates[0];
    return first ? textContent(first.content) : undefined;
  }
  for (const checkpoint of previous.toReversed()) {
    const marker = new RegExp(`(?:^|\\n)${ORIGINAL_USER_REQUEST_MARKER}\\n([^\\n]+)`).exec(
      textContent(checkpoint.content) ?? "",
    );
    if (!marker) continue;
    try {
      const record: unknown = JSON.parse(marker[1]!);
      if (record && typeof record === "object" && "text" in record && "sha256" in record) {
        if (
          typeof record.text === "string" &&
          typeof record.sha256 === "string" &&
          createHash("sha256").update(record.text).digest("hex") === record.sha256
        ) {
          return record.text;
        }
      }
    } catch {
      // Reject corrupt trusted provenance; never promote newer task text to replace it.
    }
    throw new Error("Trusted compaction summary has an invalid original-request marker");
  }
  throw new Error("Trusted compaction summaries have no recoverable original-request marker");
}

export function compactionOriginalRequestRef(parsed: CompactionSource): string | undefined {
  const original = compactionOriginalRequest(parsed);
  return original === undefined ? undefined : `sha256:${createHash("sha256").update(original).digest("hex")}`;
}
