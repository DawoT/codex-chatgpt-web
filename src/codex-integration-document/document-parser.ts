import { stripUtf8Bom } from "../config";
import { MANAGED_COMMENT, MANAGED_ROUTE_COMMENT } from "../codex-integration-shared";
import type { CodexIntegrationJournal } from "../codex-integration-shared";

export function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

export function decodeTomlString(raw: string, key: string): string {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`Could not parse ${key} in Codex config`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  throw new Error(`${key} in Codex config must be a quoted string`);
}

export function textFormat(text: string): NonNullable<CodexIntegrationJournal["format"]> {
  return {
    lineEnding: text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n",
    trailingNewline: /(?:\r\n|\n|\r)$/.test(text),
  };
}

export function splitLines(text: string): string[] {
  const normalized = stripUtf8Bom(text);
  return normalized.length > 0 ? normalized.replace(/(?:\r\n|\n|\r)$/, "").split(/\r\n|\n|\r/) : [];
}

/**
 * The Codex config belongs to the user. Every edit keeps each untouched line byte-for-byte,
 * including its own terminator, so a file with mixed line endings is never normalized.
 */
export interface CodexConfigDocument {
  lines: string[];
  endings: string[];
  utf8Bom: boolean;
}

export function parseDocument(text: string): CodexConfigDocument {
  const utf8Bom = text.startsWith("\uFEFF");
  text = stripUtf8Bom(text);
  const lines: string[] = [];
  const endings: string[] = [];
  const lineBreak = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = lineBreak.exec(text)) !== null) {
    lines.push(text.slice(start, match.index));
    endings.push(match[0]);
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
    endings.push("");
  }
  return { lines, endings, utf8Bom };
}

export function renderDocument(document: CodexConfigDocument): string {
  const text = document.lines.map((line, index) => `${line}${document.endings[index] ?? ""}`).join("");
  return document.utf8Bom ? `\uFEFF${text}` : text;
}

export function dominantLineEnding(document: CodexConfigDocument): string {
  return document.endings.find(ending => ending.length > 0) ?? "\n";
}

export function insertDocumentLine(document: CodexConfigDocument, index: number, line: string): void {
  const position = Math.max(0, Math.min(index, document.lines.length));
  const ending = dominantLineEnding(document);
  if (position === document.lines.length) {
    const lastIndex = document.lines.length - 1;
    const trailing = lastIndex >= 0 ? document.endings[lastIndex]! : ending;
    if (lastIndex >= 0) document.endings[lastIndex] = ending;
    document.lines.push(line);
    document.endings.push(trailing);
    return;
  }
  document.lines.splice(position, 0, line);
  document.endings.splice(position, 0, document.endings[position] ?? ending);
}

export function removeDocumentLine(document: CodexConfigDocument, index: number): void {
  if (index < 0 || index >= document.lines.length) return;
  const wasLast = index === document.lines.length - 1;
  const trailing = document.endings[index] ?? "";
  document.lines.splice(index, 1);
  document.endings.splice(index, 1);
  if (wasLast && document.endings.length > 0) document.endings[document.endings.length - 1] = trailing;
}

export function removeManagedComment(document: CodexConfigDocument): void {
  for (let index = document.lines.length - 1; index >= 0; index -= 1) {
    if (document.lines[index] === MANAGED_COMMENT || document.lines[index] === MANAGED_ROUTE_COMMENT) {
      removeDocumentLine(document, index);
    }
  }
}
