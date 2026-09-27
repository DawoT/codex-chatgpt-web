import {
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_MULTI_AGENT_V2_TABLE_LINE,
  MANAGED_REMOTE_COMPACTION_LINE,
  MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  managedAgentMaxDepthLine,
} from "../codex-integration-shared";
import type {
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  PreviousAgentAssignment,
  PreviousFeatureAssignment,
} from "../codex-integration-shared";
import {
  insertDocumentLine,
  parseDocument,
  removeDocumentLine,
  renderDocument,
  splitLines,
} from "./document-parser";
import {
  findAgentMaxDepthAssignment,
  findBooleanAssignmentInTable,
  findFeatureAssignment,
  findMultiAgentV2Assignment,
  findTomlTable,
  managedMultiAgentV2AssignmentLine,
  setAgentMaxDepth,
  setScalarFeature,
} from "./table-features";

export function installCompatibilityV1Features(text: string): {
  text: string;
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  previousAgentMaxDepth: PreviousAgentAssignment;
  installedAgentMaxDepth: number;
} {
  const document = parseDocument(text);
  const foundMultiAgent = findFeatureAssignment(document.lines, "multi_agent");
  const featureSeparatorInserted = !foundMultiAgent.tablePresent
    && document.lines.length > 0
    && Boolean(document.lines.at(-1)?.trim());
  const previousMultiAgent: PreviousFeatureAssignment = featureSeparatorInserted
    ? { ...foundMultiAgent, separatorInserted: true }
    : foundMultiAgent;
  const previousMultiAgentV2 = findMultiAgentV2Assignment(document.lines);
  const foundAgentMaxDepth = findAgentMaxDepthAssignment(document.lines);
  const previousAgentMaxDepth: PreviousAgentAssignment = !foundAgentMaxDepth.tablePresent
    && document.lines.length > 0
    && Boolean(document.lines.at(-1)?.trim())
    ? { ...foundAgentMaxDepth, separatorInserted: true }
    : foundAgentMaxDepth;
  const installedAgentMaxDepth = Math.max(
    previousAgentMaxDepth.present ? Number(previousAgentMaxDepth.value) : 0,
    MIN_COMPATIBILITY_V1_AGENT_DEPTH,
  );
  setScalarFeature(document, "multi_agent", MANAGED_MULTI_AGENT_LINE);
  if (previousMultiAgentV2.inlineTable) {
    if (previousMultiAgentV2.index === undefined) {
      throw new Error("Codex [features].multi_agent_v2 inline table disappeared during setup");
    }
    document.lines[previousMultiAgentV2.index] = managedMultiAgentV2AssignmentLine(previousMultiAgentV2);
  } else if (previousMultiAgentV2.tableName === "features.multi_agent_v2") {
    const current = findBooleanAssignmentInTable(
      document.lines,
      "features.multi_agent_v2",
      "enabled",
    );
    if (current.index !== undefined) {
      document.lines[current.index] = MANAGED_MULTI_AGENT_V2_TABLE_LINE;
    } else {
      const table = findTomlTable(document.lines, "features.multi_agent_v2");
      if (!table) throw new Error("Codex [features.multi_agent_v2] table disappeared during setup");
      insertDocumentLine(document, table.endIndex, MANAGED_MULTI_AGENT_V2_TABLE_LINE);
    }
  } else {
    setScalarFeature(document, "multi_agent_v2", MANAGED_MULTI_AGENT_V2_LINE);
  }
  setAgentMaxDepth(document, installedAgentMaxDepth);
  return {
    text: renderDocument(document),
    previousMultiAgent,
    previousMultiAgentV2,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  };
}

function verifyInstalledBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
): void {
  const current = findFeatureAssignment(splitLines(text), key);
  if (current.value !== expectedValue || current.rawLine !== managedLine) {
    throw new Error(
      `Codex [features].${key} changed after setup; refusing to overwrite the user's newer value`,
    );
  }
}

function verifyInstalledMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): void {
  if (previous.inlineTable) {
    const current = findMultiAgentV2Assignment(splitLines(text));
    if (!current.inlineTable
      || current.value !== "false"
      || current.rawLine !== managedMultiAgentV2AssignmentLine(previous)) {
      throw new Error(
        "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
      );
    }
    return;
  }
  if (previous.tableName !== "features.multi_agent_v2") {
    const current = findMultiAgentV2Assignment(splitLines(text));
    if (current.tableName !== "features"
      || current.value !== "false"
      || current.rawLine !== MANAGED_MULTI_AGENT_V2_LINE) {
      throw new Error(
        "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
      );
    }
    return;
  }
  const lines = splitLines(text);
  if (findFeatureAssignment(lines, "multi_agent_v2").present) {
    throw new Error(
      "Codex [features].multi_agent_v2 changed after setup; refusing to overwrite the user's newer value",
    );
  }
  const current = findBooleanAssignmentInTable(lines, "features.multi_agent_v2", "enabled");
  if (current.value !== "false" || current.rawLine !== MANAGED_MULTI_AGENT_V2_TABLE_LINE) {
    throw new Error(
      "Codex [features.multi_agent_v2].enabled changed after setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreBooleanFeature(
  text: string,
  key: string,
  expectedValue: "true" | "false",
  managedLine: string,
  previous: PreviousFeatureAssignment,
): string {
  verifyInstalledBooleanFeature(text, key, expectedValue, managedLine);
  const document = parseDocument(text);
  const current = findFeatureAssignment(document.lines, key);
  if (current.index === undefined) throw new Error(`Managed Codex ${key} is missing`);
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error(`Codex integration journal is missing the prior ${key} line`);
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previous.tablePresent) {
      const table = findTomlTable(document.lines, "features");
      if (!table) throw new Error("Managed Codex [features] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) {
        const headerIndex = table.headerIndex;
        removeDocumentLine(document, headerIndex);
        if (previous.separatorInserted && document.lines[headerIndex - 1] === "") {
          removeDocumentLine(document, headerIndex - 1);
        }
      }
    }
  }
  return renderDocument(document);
}

export function restoreMultiAgentV2Feature(
  text: string,
  previous: PreviousFeatureAssignment,
): string {
  if (previous.inlineTable) {
    verifyInstalledMultiAgentV2Feature(text, previous);
    if (!previous.rawLine) {
      throw new Error("Codex integration journal is missing the prior multi_agent_v2 inline table");
    }
    const document = parseDocument(text);
    const current = findMultiAgentV2Assignment(document.lines);
    if (current.index === undefined) throw new Error("Managed Codex multi_agent_v2 inline table is missing");
    document.lines[current.index] = previous.rawLine;
    return renderDocument(document);
  }
  if (previous.tableName !== "features.multi_agent_v2") {
    return restoreBooleanFeature(
      text,
      "multi_agent_v2",
      "false",
      MANAGED_MULTI_AGENT_V2_LINE,
      previous,
    );
  }
  verifyInstalledMultiAgentV2Feature(text, previous);
  const document = parseDocument(text);
  const current = findBooleanAssignmentInTable(
    document.lines,
    "features.multi_agent_v2",
    "enabled",
  );
  if (current.index === undefined) throw new Error("Managed Codex multi_agent_v2.enabled is missing");
  if (previous.present) {
    if (!previous.rawLine) {
      throw new Error("Codex integration journal is missing the prior multi_agent_v2.enabled line");
    }
    document.lines[current.index] = previous.rawLine;
  } else {
    removeDocumentLine(document, current.index);
  }
  return renderDocument(document);
}

export function verifyInstalledFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): void {
  verifyInstalledBooleanFeature(
    text,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
  );
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  if (journal.version === 6) {
    verifyInstalledMultiAgentV2Feature(text, journal.previousMultiAgentV2);
  }
}

export function verifyCompatibilityV1Features(
  text: string,
  previousMultiAgentV2: PreviousFeatureAssignment,
  installedAgentMaxDepth: number,
): void {
  verifyInstalledBooleanFeature(text, "multi_agent", "true", MANAGED_MULTI_AGENT_LINE);
  verifyInstalledMultiAgentV2Feature(text, previousMultiAgentV2);
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

function verifyCompatibilityV1AgentDepth(text: string, installedAgentMaxDepth: number): void {
  const depth = findAgentMaxDepthAssignment(splitLines(text));
  if (depth.value !== String(installedAgentMaxDepth)
    || depth.rawLine !== managedAgentMaxDepthLine(installedAgentMaxDepth)) {
    throw new Error(
      "Codex [agents].max_depth changed after Compatibility V1 setup; refusing to overwrite the user's newer value",
    );
  }
}

export function restoreCompatibilityV1AgentDepth(
  text: string,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  verifyCompatibilityV1AgentDepth(text, installedAgentMaxDepth);
  const document = parseDocument(text);
  const current = findAgentMaxDepthAssignment(document.lines);
  if (current.index === undefined) throw new Error("Managed Codex [agents].max_depth is missing");
  if (previousAgentMaxDepth.present) {
    if (!previousAgentMaxDepth.rawLine) {
      throw new Error("Codex integration journal is missing the prior [agents].max_depth line");
    }
    document.lines[current.index] = previousAgentMaxDepth.rawLine;
  } else {
    removeDocumentLine(document, current.index);
    if (!previousAgentMaxDepth.tablePresent) {
      const table = findTomlTable(document.lines, "agents");
      if (!table) throw new Error("Managed Codex [agents] table is missing");
      const remaining = document.lines
        .slice(table.headerIndex + 1, table.endIndex)
        .filter(line => line.trim().length > 0);
      if (remaining.length === 0) {
        const headerIndex = table.headerIndex;
        removeDocumentLine(document, headerIndex);
        if (previousAgentMaxDepth.separatorInserted && document.lines[headerIndex - 1] === "") {
          removeDocumentLine(document, headerIndex - 1);
        }
      }
    }
  }
  return renderDocument(document);
}

export function restoreCompatibilityV1Features(
  text: string,
  previousMultiAgent: PreviousFeatureAssignment,
  previousMultiAgentV2: PreviousFeatureAssignment,
  previousAgentMaxDepth: PreviousAgentAssignment,
  installedAgentMaxDepth: number,
): string {
  let restored = restoreBooleanFeature(
    restoreMultiAgentV2Feature(text, previousMultiAgentV2),
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    previousMultiAgent,
  );
  restored = restoreCompatibilityV1AgentDepth(
    restored,
    previousAgentMaxDepth,
    installedAgentMaxDepth,
  );
  return restored;
}

export function restoreManagedFeatures(
  text: string,
  journal: LegacyCodexIntegrationJournalV6 | LegacyCodexIntegrationJournalV5,
): string {
  const withoutMultiAgentV2 = journal.version === 6
    ? restoreMultiAgentV2Feature(text, journal.previousMultiAgentV2)
    : text;
  const withoutMultiAgent = restoreBooleanFeature(
    withoutMultiAgentV2,
    "multi_agent",
    "true",
    MANAGED_MULTI_AGENT_LINE,
    journal.previousMultiAgent,
  );
  return restoreBooleanFeature(
    withoutMultiAgent,
    "remote_compaction_v2",
    "false",
    MANAGED_REMOTE_COMPACTION_LINE,
    journal.previousRemoteCompactionV2,
  );
}
