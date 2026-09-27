import {
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  managedAgentMaxDepthLine,
} from "../codex-integration-shared";
import type {
  PreviousAgentAssignment,
  PreviousAssignment,
  PreviousFeatureAssignment,
} from "../codex-integration-shared";
import { assignmentRegex } from "./assignments";
import {
  type CodexConfigDocument,
  insertDocumentLine,
  stripTomlComment,
} from "./document-parser";
import { parseInlineBooleanField } from "./inline-tables";

export interface TomlTableRange {
  headerIndex: number;
  endIndex: number;
}

export function findTomlTable(lines: string[], tableName: string): TomlTableRange | undefined {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  const matches = lines
    .map((line, index) => header.test(line) ? index : -1)
    .filter(index => index >= 0);
  if (matches.length > 1) throw new Error(`Codex config contains duplicate [${tableName}] tables`);
  const headerIndex = matches[0];
  if (headerIndex === undefined) return undefined;
  const relativeEnd = lines
    .slice(headerIndex + 1)
    .findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return {
    headerIndex,
    endIndex: relativeEnd < 0 ? lines.length : headerIndex + 1 + relativeEnd,
  };
}

export function insertFeatureTable(document: CodexConfigDocument): TomlTableRange {
  if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
    insertDocumentLine(document, document.lines.length, "");
  }
  insertDocumentLine(document, document.lines.length, "[features]");
  return findTomlTable(document.lines, "features")!;
}

export function setScalarFeature(
  document: CodexConfigDocument,
  key: string,
  managedLine: string,
): void {
  const current = findFeatureAssignment(document.lines, key);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  const table = findTomlTable(document.lines, "features") ?? insertFeatureTable(document);
  insertDocumentLine(document, table.endIndex, managedLine);
}

export function rawAssignmentInTable(
  lines: string[],
  tableName: "features" | "features.multi_agent_v2",
  key: string,
): PreviousFeatureAssignment {
  const table = findTomlTable(lines, tableName);
  if (!table) return { present: false, tablePresent: false, tableName };
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push({ present: true, rawLine: line, value: match[1]!, index });
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains duplicate [${tableName}].${key} assignments`);
  }
  return { ...(matches[0] ?? { present: false }), tablePresent: true, tableName };
}

export function findBooleanAssignmentInTable(
  lines: string[],
  tableName: "features" | "features.multi_agent_v2",
  key: string,
): PreviousFeatureAssignment {
  const assignment = rawAssignmentInTable(lines, tableName, key);
  if (!assignment.present) return assignment;
  const value = stripTomlComment(assignment.value!).trim();
  if (value !== "true" && value !== "false") {
    throw new Error(`${key} in Codex [${tableName}] must be a boolean`);
  }
  return { ...assignment, value };
}

export function findAgentMaxDepthAssignment(lines: string[]): PreviousAgentAssignment {
  const table = findTomlTable(lines, "agents");
  if (!table) return { present: false, tablePresent: false };
  const regex = assignmentRegex("max_depth");
  const matches: PreviousAssignment[] = [];
  for (let index = table.headerIndex + 1; index < table.endIndex; index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (!match) continue;
    const value = stripTomlComment(match[1]!).trim().replaceAll("_", "");
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error("max_depth in Codex [agents] must be a positive integer");
    }
    matches.push({ present: true, rawLine: line, value, index });
  }
  if (matches.length > 1) throw new Error("Codex config contains duplicate [agents].max_depth assignments");
  return { ...(matches[0] ?? { present: false }), tablePresent: true };
}

export function setAgentMaxDepth(document: CodexConfigDocument, value: number): void {
  const current = findAgentMaxDepthAssignment(document.lines);
  const managedLine = managedAgentMaxDepthLine(value);
  if (current.index !== undefined) {
    document.lines[current.index] = managedLine;
    return;
  }
  let table = findTomlTable(document.lines, "agents");
  if (!table) {
    if (document.lines.length > 0 && document.lines.at(-1)?.trim()) {
      insertDocumentLine(document, document.lines.length, "");
    }
    insertDocumentLine(document, document.lines.length, "[agents]");
    table = findTomlTable(document.lines, "agents")!;
  }
  let insertionIndex = table.endIndex;
  while (insertionIndex > table.headerIndex + 1 && document.lines[insertionIndex - 1]?.trim() === "") {
    insertionIndex -= 1;
  }
  insertDocumentLine(document, insertionIndex, managedLine);
}

export function findFeatureAssignment(lines: string[], key: string): PreviousFeatureAssignment {
  return findBooleanAssignmentInTable(lines, "features", key);
}

export function findMultiAgentV2Assignment(lines: string[]): PreviousFeatureAssignment {
  const rawScalar = rawAssignmentInTable(lines, "features", "multi_agent_v2");
  const table = findTomlTable(lines, "features.multi_agent_v2");
  if (rawScalar.present && table) {
    throw new Error(
      "Codex config defines multi_agent_v2 as both [features] scalar and [features.multi_agent_v2] table",
    );
  }
  if (table) return findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled");
  if (!rawScalar.present) return rawScalar;
  const rawValue = rawScalar.value!;
  const scalarValue = stripTomlComment(rawValue).trim();
  if (scalarValue === "true" || scalarValue === "false") {
    return { ...rawScalar, value: scalarValue };
  }
  const inline = parseInlineBooleanField(rawValue, "multi_agent_v2");
  if (!inline) throw new Error("multi_agent_v2 in Codex [features] must be a boolean or inline table");
  return { ...rawScalar, value: inline.value, inlineTable: true };
}

export function managedMultiAgentV2AssignmentLine(previous: PreviousFeatureAssignment): string {
  if (!previous.inlineTable) {
    return previous.tableName === "features.multi_agent_v2"
      ? MANAGED_MULTI_AGENT_V2_TABLE_LINE
      : MANAGED_MULTI_AGENT_V2_LINE;
  }
  if (!previous.rawLine) {
    throw new Error("Codex integration journal is missing the prior multi_agent_v2 inline table");
  }
  const prefix = /^\s*multi_agent_v2\s*=\s*/.exec(previous.rawLine);
  if (!prefix) throw new Error("Could not parse the prior multi_agent_v2 inline table");
  const rawValue = previous.rawLine.slice(prefix[0].length);
  const inline = parseInlineBooleanField(rawValue, "multi_agent_v2");
  if (!inline) throw new Error("Could not parse the prior multi_agent_v2 inline table");
  if (inline.valueStart !== undefined && inline.valueEnd !== undefined) {
    return previous.rawLine.slice(0, prefix[0].length + inline.valueStart)
      + "false"
      + previous.rawLine.slice(prefix[0].length + inline.valueEnd);
  }
  const bodyHasValues = rawValue.slice(0, inline.bodyContentEnd).trimEnd().endsWith("{") === false;
  return previous.rawLine.slice(0, prefix[0].length + inline.bodyContentEnd)
    + `${bodyHasValues ? ", " : ""}enabled = false`
    + previous.rawLine.slice(prefix[0].length + inline.bodyContentEnd);
}
