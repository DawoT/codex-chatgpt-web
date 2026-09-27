import { existsSync, readFileSync } from "node:fs";
import { getCodexConfigPath } from "../codex-integration-shared";
import type {
  CodexModelContextOverride,
  ManagedAssignmentKey,
  PreviousAssignment,
} from "../codex-integration-shared";
import { decodeTomlString, splitLines, stripTomlComment } from "./document-parser";

export function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

export function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`);
}

export function findTopLevelAssignment(lines: string[], key: string): PreviousAssignment {
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ present: true, rawLine: line, value: decodeTomlString(match[1]!, key), index });
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  return matches[0] ?? { present: false };
}

export function findTopLevelPositiveInteger(lines: string[], key: string): number | undefined {
  const regex = assignmentRegex(key);
  const matches: string[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push(stripTomlComment(match[1]!).trim());
  }
  if (matches.length > 1) throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  if (matches.length === 0) return undefined;
  const normalized = matches[0]!.replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) throw new Error(`${key} in Codex config must be a positive integer`);
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} in Codex config must be a positive integer`);
  return value;
}

export function readCodexModelContextOverride(): CodexModelContextOverride | undefined {
  const path = getCodexConfigPath();
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const lines = splitLines(text);
  const contextWindow = findTopLevelPositiveInteger(lines, "model_context_window");
  return contextWindow === undefined ? undefined : { contextWindow };
}

export function assignments(lines: string[]): Record<ManagedAssignmentKey, PreviousAssignment> {
  return {
    openai_base_url: findTopLevelAssignment(lines, "openai_base_url"),
    model_provider: findTopLevelAssignment(lines, "model_provider"),
    model_catalog_json: findTopLevelAssignment(lines, "model_catalog_json"),
  };
}
