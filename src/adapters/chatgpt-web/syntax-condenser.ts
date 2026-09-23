/**
 * Syntax and Diff-Aware Prose & Code Condenser for Stage 1 Micro-Compaction.
 * Preserves structural syntax, balanced code fences, and diff headers
 * instead of slicing strings at arbitrary character offsets.
 */

const COMMENT_CHARS: Record<string, string> = {
  python: "#",
  py: "#",
  bash: "#",
  sh: "#",
  zsh: "#",
  shell: "#",
  yaml: "#",
  yml: "#",
  toml: "#",
  ruby: "#",
  rb: "#",
  perl: "#",
  pl: "#",
  diff: "#",
  patch: "#",
};

function getCommentPrefix(lang: string): string {
  const normalized = lang.toLowerCase().trim();
  return COMMENT_CHARS[normalized] ?? "//";
}

/**
 * Condenses a single markdown code block while preserving fence boundaries,
 * language tags, and high-level signature lines.
 */
function condenseCodeBlock(lang: string, code: string): string {
  const trimmed = code.trim();
  if (trimmed.length <= 160) {
    return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
  }

  const lines = trimmed.split("\n");
  const normalizedLang = lang.toLowerCase().trim();

  // Diff / patch block condensation
  if (normalizedLang === "diff" || normalizedLang === "patch" || lines[0]?.startsWith("diff --git")) {
    const headerLines: string[] = [];
    for (let i = 0; i < Math.min(lines.length, 4); i++) {
      const line = lines[i]!;
      if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("index ")) {
        headerLines.push(line);
      } else {
        break;
      }
    }
    const header = headerLines.length > 0 ? `${headerLines.join("\n")}\n` : "";
    return `\`\`\`${lang}\n${header}[... diff hunks omitted for context budget ...]\n\`\`\``;
  }

  // JSON block condensation
  if (normalizedLang === "json") {
    const isArray = trimmed.startsWith("[") && trimmed.endsWith("]");
    if (isArray) {
      return `\`\`\`json\n[\n  "// [... array contents omitted for context budget ...]"\n]\n\`\`\``;
    }
    return `\`\`\`json\n{\n  "_context": "[... json properties omitted for context budget ...]"\n}\n\`\`\``;
  }

  // Standard programming languages (ts, js, py, rs, go, sh, etc.)
  const comment = getCommentPrefix(lang);
  const headLines: string[] = [];
  let charCount = 0;
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    const line = lines[i]!;
    if (charCount + line.length > 120 && headLines.length > 0) break;
    headLines.push(line);
    charCount += line.length;
  }

  const lastLine = lines.length > 1 ? lines[lines.length - 1]!.trim() : "";
  const trailingLine = lastLine === "}" || lastLine === ");" || lastLine === "]" || lastLine === "end" ? `\n${lastLine}` : "";

  return `\`\`\`${lang}\n${headLines.join("\n")}\n${comment} [... implementation details omitted for context budget ...]${trailingLine}\n\`\`\``;
}

/**
 * Finds a clean word or newline boundary near the target index.
 */
function findBoundary(text: string, targetIndex: number, searchForward = false): number {
  if (targetIndex <= 0) return 0;
  if (targetIndex >= text.length) return text.length;

  const windowSize = 30;
  const start = Math.max(0, targetIndex - windowSize);
  const end = Math.min(text.length, targetIndex + windowSize);
  const chunk = text.slice(start, end);

  if (searchForward) {
    const match = chunk.match(/[\n\.\s]/);
    if (match && match.index !== undefined) {
      return start + match.index + 1;
    }
  } else {
    const matches = [...chunk.matchAll(/[\n\.\s]/g)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1]!;
      if (lastMatch.index !== undefined) {
        return start + lastMatch.index;
      }
    }
  }

  return targetIndex;
}

/**
 * Condenses verbose assistant prose (>400 chars) while preserving markdown code fences,
 * language tags, AST signatures, and balanced delimiters.
 */
export function condenseVerboseProseWithSyntaxAwareness(text: string, maxChars = 400): string {
  if (text.length <= maxChars) {
    return text;
  }

  const codeFenceRegex = /```([a-zA-Z0-9_\-\.]*)\n([\s\S]*?)```/g;
  let hasCodeFences = false;
  let lastIndex = 0;
  const parts: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = codeFenceRegex.exec(text)) !== null) {
    hasCodeFences = true;
    const matchStart = match.index;
    const matchEnd = codeFenceRegex.lastIndex;

    // Prose before this code fence
    if (matchStart > lastIndex) {
      parts.push(text.slice(lastIndex, matchStart));
    }

    // Condensed code block
    const lang = match[1] ?? "";
    const code = match[2] ?? "";
    parts.push(condenseCodeBlock(lang, code));

    lastIndex = matchEnd;
  }

  // Trailing prose after the last code block
  if (hasCodeFences) {
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex));
    }

    let combined = parts.join("");
    if (combined.length <= maxChars) {
      return combined;
    }

    // If still over budget, compress prose segments surrounding the code blocks
    const compressedParts = parts.map(part => {
      if (part.startsWith("```") && part.endsWith("```")) {
        return part;
      }
      if (part.length > 150) {
        const headIdx = findBoundary(part, 80, false);
        const tailIdx = findBoundary(part, part.length - 60, true);
        return `${part.slice(0, headIdx).trimEnd()}\n[... discussion omitted ...]\n${part.slice(tailIdx).trimStart()}`;
      }
      return part;
    });

    combined = compressedParts.join("");
    // Ensure fence balance
    const fenceCount = (combined.match(/```/g) || []).length;
    if (fenceCount % 2 !== 0) {
      combined += "\n```";
    }
    return combined;
  }

  // Standard prose without code fences: clean boundary condensation
  const headCut = findBoundary(text, 140, false);
  const tailCut = findBoundary(text, text.length - 140, true);

  const prefix = text.slice(0, headCut).trimEnd();
  const suffix = text.slice(tailCut).trimStart();

  return `${prefix}\n[... intermediate discussion omitted for context budget ...]\n${suffix}`;
}
