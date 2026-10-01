import { expect, test } from "bun:test";
import {
  compactionControlPolicy,
  initialCompactionRoute,
  retainedCompactionStrategy,
} from "../src/adapters/chatgpt-web/adapter/compaction-policy";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test("structured compaction requires retained control except for classic models", () => {
  const input = {
    modelId: "chatgpt-web/test",
    localToolsEnabled: true,
    manualRequest: false,
    retainedLauncherDescriptor: undefined,
    hasStructuredBroker: false,
  };
  expect(compactionControlPolicy(input)).toBe("unavailable");
  expect(compactionControlPolicy({ ...input, modelId: CHATGPT_WEB_LUNA_MODEL_ID })).toBe("classic");
  expect(compactionControlPolicy({ ...input, localToolsEnabled: false })).toBe("classic");
  expect(compactionControlPolicy({ ...input, retainedLauncherDescriptor: "launcher" })).toBe("unavailable");
  expect(compactionControlPolicy({ ...input, retainedLauncherDescriptor: "launcher", manualRequest: true })).toBe(
    "structured",
  );
  expect(compactionControlPolicy({ ...input, retainedLauncherDescriptor: "launcher", hasStructuredBroker: true })).toBe(
    "structured",
  );
});

test("tool count alone does not replace a retained conversation", () => {
  expect(initialCompactionRoute({ freshConversationPerTurn: true, heavyTurn: true })).toBe(
    "configured_fresh_conversation",
  );
  expect(initialCompactionRoute({ freshConversationPerTurn: false, heavyTurn: true })).toBe("retained");
  expect(initialCompactionRoute({ freshConversationPerTurn: false, heavyTurn: false })).toBe("retained");
});

test("only an active tools source can settle through a tool boundary", () => {
  for (const manualRequest of [true, false]) {
    const prefix = manualRequest ? "zero-risk" : "retained";
    expect(retainedCompactionStrategy({ manualRequest, sourceActive: true, sourceMode: "tools" })).toBe(
      `${prefix}-tools`,
    );
    expect(retainedCompactionStrategy({ manualRequest, sourceActive: false, sourceMode: "tools" })).toBe(
      `${prefix}-completed`,
    );
    expect(retainedCompactionStrategy({ manualRequest, sourceActive: true, sourceMode: "read-only" })).toBe(
      `${prefix}-completed`,
    );
  }
});
