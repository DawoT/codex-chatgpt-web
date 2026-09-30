import { expect, test } from "bun:test";
import { buildMultipartPlan } from "../src/adapters/chatgpt-web/browser/multipart-plan";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  type ChatGptWebCapabilities,
  resolveChatGptWebModelMode,
} from "../src/adapters/chatgpt-web/model";
import {
  type CompiledChatGptWebPrompt,
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { resolveChatGptWebMessageTokenBudget } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: false,
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
};

function compileTwoPartPrompt(): CompiledChatGptWebPrompt {
  return compileChatGptWebPrompt(
    {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "low" },
      context: {
        systemPrompt: ["Keep literal paths."],
        messages: [
          { role: "user", content: "Read the first file.", timestamp: 1 },
          { role: "user", content: "Compare it with the second file.", timestamp: 2 },
        ],
      },
    },
    capabilities,
    undefined,
    { experimentalMultipartParts: 2 },
  );
}

test("a two-part prompt plans one stage, the commit prompt, and the selected message order", () => {
  const prepared = compileTwoPartPrompt();
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  const plan = buildMultipartPlan(prepared, {
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities,
    requestedMode,
    compaction: false,
  });

  expect(prepared.multipart).toBeDefined();
  expect(plan.multipartTransactionId).toMatch(/^ctx_[a-f0-9]{32}$/);
  expect(plan.multipartStages).toHaveLength(prepared.multipart!.parts.length - 1);

  const stage = plan.multipartStages![0]!;
  expect(stage).toEqual(
    formatChatGptWebMultipartStage(
      prepared.multipart!.parts[0]!,
      plan.multipartTransactionId!,
      1,
      prepared.multipart!.parts.length,
    ),
  );
  expect(stage.text).toContain("<codex_multipart_stage>");
  expect(stage.text).toContain(`transaction_id: ${plan.multipartTransactionId}`);
  expect(stage.text).toContain(`part: 1/${prepared.multipart!.parts.length}`);

  const commitPrompt = formatChatGptWebMultipartCommit(prepared.multipart!, plan.multipartTransactionId!);
  expect(plan.multipartFinalPrompt).toBe(commitPrompt);
  expect(commitPrompt).toContain("<codex_multipart_commit>");
  expect(commitPrompt).toContain(`parts: ${prepared.multipart!.parts.length}`);
  expect(commitPrompt).toContain(
    `acknowledged_parts: ${prepared.multipart!.parts.length - 1}/${prepared.multipart!.parts.length}`,
  );
  expect(commitPrompt).toContain(prepared.multipart!.parts.at(-1)!);

  expect(plan.selectedMessages).toEqual([stage.text, commitPrompt]);
  expect(plan.browserPayload.messageCount).toBe(prepared.multipart!.parts.length);

  expect(plan.maxStageMessageTokens).toBe(estimateTokens(stage.text, CHATGPT_WEB_MODEL_ID));
  expect(plan.maxStageChars).toBe(stage.text.length);
  // Small stages fit the requested effort, so staging does not escalate.
  expect(plan.stagingMode.effort).toBe(requestedMode.effort);
  expect(plan.estimatedInputTokens).toBeGreaterThan(0);
  expect(plan.maxMessageChars).toBeGreaterThan(0);
});

test("an inline prompt keeps the requested mode and the single canonical message", () => {
  const prepared = compileChatGptWebPrompt(
    {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "low" },
      context: { messages: [{ role: "user", content: "Hello there.", timestamp: 1 }] },
    },
    capabilities,
  );
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  const plan = buildMultipartPlan(prepared, {
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities,
    requestedMode,
    compaction: false,
  });

  expect(plan.multipartTransactionId).toBeUndefined();
  expect(plan.multipartStages).toBeUndefined();
  expect(plan.multipartFinalPrompt).toBeUndefined();
  expect(plan.maxStageMessageTokens).toBeUndefined();
  expect(plan.maxStageChars).toBeUndefined();
  expect(plan.selectedMessages).toEqual([prepared.text]);
  expect(plan.browserPayload.messageCount).toBe(1);
  expect(plan.stagingMode).toBe(requestedMode);
});

test("staging effort escalates when a stage exceeds the requested effort's transport budget", () => {
  const lowBudget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  const mediumBudget = resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_MODEL_ID, "medium", capabilities);
  expect(lowBudget).toBeLessThan(mediumBudget);

  const stageText = (payloadChars: number) =>
    formatChatGptWebMultipartStage(JSON.stringify({ note: "一".repeat(payloadChars) }), `ctx_${"a".repeat(32)}`, 1, 2)
      .text;

  // Each CJK character costs roughly one token, so a payload a little larger than the low budget
  // crosses it while staying well under the safe staging char limit. The assertions below fail
  // loudly if that density assumption ever stops holding.
  const payloadChars = lowBudget + 2_000;
  const stage = stageText(payloadChars);
  const stageTokens = estimateTokens(stage, CHATGPT_WEB_MODEL_ID);
  expect(stageTokens).toBeGreaterThan(lowBudget);
  expect(stageTokens).toBeLessThanOrEqual(mediumBudget);
  expect(stage.length).toBeLessThanOrEqual(45_000);

  const prepared: CompiledChatGptWebPrompt = {
    text: "Do the task.",
    images: [],
    multipart: {
      parts: [JSON.stringify({ note: "一".repeat(payloadChars) }), JSON.stringify({ task: "Do the task." })],
      commit: "Do the task.",
    },
  };
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  const plan = buildMultipartPlan(prepared, {
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities,
    requestedMode,
    compaction: false,
  });
  expect(plan.stagingMode.effort).toBe("medium");
  expect(plan.stagingMode.effort).not.toBe(requestedMode.effort);
});

test("a stage beyond the safe browser char boundary throws before any browser work", () => {
  const prepared: CompiledChatGptWebPrompt = {
    text: "Do the task.",
    images: [],
    multipart: {
      parts: [JSON.stringify({ note: "x".repeat(50_000) }), JSON.stringify({ task: "Do the task." })],
      commit: "Do the task.",
    },
  };
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  expect(() =>
    buildMultipartPlan(prepared, {
      modelId: CHATGPT_WEB_MODEL_ID,
      capabilities,
      requestedMode,
      compaction: false,
    }),
  ).toThrow(/safe browser boundary/);
});

test("a multipart plan for Luna is rejected outright", () => {
  const lunaCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: false,
    solAvailable: false,
    extraHighAvailable: false,
    proAvailable: false,
  };
  const prepared: CompiledChatGptWebPrompt = {
    text: "Do the task.",
    images: [],
    multipart: { parts: ["1", "2"], commit: "Do the task." },
  };
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", lunaCapabilities);
  expect(() =>
    buildMultipartPlan(prepared, {
      modelId: CHATGPT_WEB_LUNA_MODEL_ID,
      capabilities: lunaCapabilities,
      requestedMode,
      compaction: false,
    }),
  ).toThrow(/Luna/);
});

test("staging mode resolution never returns an effort the account cannot select", () => {
  // Non-pro accounts cannot select "max"; a stage whose tokens exceed every selectable effort's
  // budget must fail loudly instead of silently returning an unselectable effort. Compaction is
  // true here so the assert exercises the staging-resolution guard, not the preflight char limit.
  const prepared: CompiledChatGptWebPrompt = {
    text: "Do the task.",
    images: [],
    multipart: {
      parts: [JSON.stringify({ note: "一".repeat(82_500) }), JSON.stringify({ task: "Do the task." })],
      commit: "Do the task.",
    },
  };
  const requestedMode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
  expect(() =>
    buildMultipartPlan(prepared, {
      modelId: CHATGPT_WEB_MODEL_ID,
      capabilities,
      requestedMode,
      compaction: true,
    }),
  ).toThrow(/No ChatGPT effort available/);
});
