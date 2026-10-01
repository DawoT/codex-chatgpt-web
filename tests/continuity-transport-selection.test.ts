import { expect, test } from "bun:test";
import { buildMultipartPlan } from "../src/adapters/chatgpt-web/browser/multipart-plan";
import { compiledChatGptWebMessages } from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { reconstructMultipartRecords } from "../src/adapters/chatgpt-web/prompt/record-fragments";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
};
const fragmentCapability = "continuity-record-fragments-v1";

function request(text: string, compaction = false): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: false,
    options: { reasoning: "high" },
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    ...(compaction ? { _compactionRequest: true } : {}),
  };
}

// Catches a new encoding being submitted by a helper without negotiated support.
test("fragment transport is advertised and refuses an incompatible helper before Send", () => {
  const parsed = request("x".repeat(104_767), true);
  const prepared = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: 6 });
  expect(prepared.multipart!.transport).toEqual({
    encodingVersion: 2,
    encoding: "record-fragments-v1",
    requiredHelperCapabilities: [fragmentCapability],
  });
  expect(prepared.compilation!.transport).toEqual(prepared.multipart!.transport);
  const params = {
    modelId: parsed.modelId,
    capabilities,
    requestedMode: resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities),
    compaction: true,
  };
  expect(() => buildMultipartPlan(prepared, params)).toThrow(/continuity-record-fragments-v1/);
  expect(() => buildMultipartPlan(prepared, { ...params, helperCapabilities: ["unknown"] })).toThrow(
    /continuity-record-fragments-v1/,
  );
  const plan = buildMultipartPlan(prepared, { ...params, helperCapabilities: [fragmentCapability] });
  expect(plan.selectedMessages).toEqual(
    compiledChatGptWebMessages(prepared).map((message) =>
      message.replaceAll(`ctx_${"0".repeat(32)}`, plan.multipartTransactionId!),
    ),
  );
  expect(plan.selectedMessages.every((message) => message.length <= 45_000 && !message.includes("data_base64"))).toBe(
    true,
  );
  expect(reconstructMultipartRecords(prepared.multipart!.parts)).toEqual([
    { kind: "message", message_index: 0, message: { role: "user", content: parsed.context.messages[0]!.content } },
  ]);
  expect(prepared.trimmedCompactionMessages).toBeUndefined();
}, 30_000);

// Catches unconditional six-part compaction or capability forcing maximum staging.
test("small compaction stays inline even when Bigger Context is available", () => {
  const parsed = request("Summarize the unresolved obligations.", true);
  expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBeUndefined();
  const enabled = { ...capabilities, experimentalBiggerContext: true };
  expect(resolveBiggerContextMultipartParts(parsed, enabled)).toBeUndefined();
  expect(compileChatGptWebPrompt(parsed, capabilities).multipart).toBeUndefined();
}, 30_000);

// Catches automatic compaction bypassing selection or requiring six stages when two fit.
test("automatic compaction uses two parts when the complete inline payload exceeds its safe boundary", () => {
  const parsed = request("x ".repeat(35_000), true);
  expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBe(2);
  const compiled = compileChatGptWebPrompt(parsed, capabilities);
  expect(compiled.multipart?.parts.length).toBe(2);
  expect(compiledChatGptWebMessages(compiled).every((message) => message.length <= 45_000)).toBe(true);
  expect(reconstructMultipartRecords(compiled.multipart!.parts)).toEqual([
    { kind: "message", message_index: 0, message: { role: "user", content: parsed.context.messages[0]!.content } },
  ]);
}, 30_000);

// Catches automatic staging inventing a larger total window without Bigger Context capability.
test("automatic transport keeps the existing total context limit unless Bigger Context is enabled", () => {
  const parsed = request("", true);
  parsed.context.messages = Array.from({ length: 24 }, (_, index) => ({
    role: "user",
    content: "一 ".repeat(4_000),
    timestamp: index,
  }));
  expect(() => {
    compileChatGptWebPrompt(parsed, capabilities);
  }).toThrow(/context window|context ceiling/);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: 6 });
  expect(compiled.multipart?.parts.length).toBe(6);
  expect(resolveBiggerContextMultipartParts(parsed, capabilities)).toBe(6);
  expect(compiledChatGptWebMessages(compiled).every((message) => message.length <= 45_000)).toBe(true);
}, 30_000);

// Catches optimistic fallback returning six when even its complete physical payload is invalid.
test("selection validates six parts and explicitly refuses histories no supported transport can carry", () => {
  for (const compaction of [false, true]) {
    expect(resolveBiggerContextMultipartParts(request("x".repeat(104_767), compaction), capabilities)).toBe(6);
    expect(() => resolveBiggerContextMultipartParts(request("x ".repeat(137_500), compaction), capabilities)).toThrow();
  }
}, 30_000);
