import { expect, test } from "bun:test";
import * as tokens from "../src/adapters/chatgpt-web/input-tokens";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";

test("combined compiled metrics retain inline text and platform budgets", () => {
  const compiled = compileChatGptWebPrompt(
    {
      modelId: "gpt-5.6-sol",
      stream: false,
      options: {},
      context: { messages: [{ role: "user", content: "Preserve the evidence 😀", timestamp: 1 }] },
    },
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  );
  const measure = (tokens as any).measureCompiledChatGptWebInput;
  expect(typeof measure).toBe("function");
  const metrics = measure(compiled, "gpt-5.6-sol");
  const textTokens = estimateTokens(compiled.text);
  expect(metrics).toEqual({
    inputTokens: textTokens + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
    maxMessageTokens: textTokens,
    maxMessageChars: compiled.text.length,
  });
});

test("multipart totals include acknowledgments, images and final attachments exactly once", () => {
  const transaction = `ctx_${"0".repeat(32)}`;
  const multipart = {
    parts: ['{"records":[{"message":{"role":"user","content":"first evidence"}}]}', '{"records":[]}'],
    commit: "answer the question",
  };
  const stage = formatChatGptWebMultipartStage(multipart.parts[0], transaction, 1, 2);
  const final = formatChatGptWebMultipartCommit(multipart, transaction);
  const attachment = "Follow the supplied constraints. ".repeat(100);
  const stageTokens = estimateTokens(stage.text);
  const finalTokens = estimateTokens(final) + estimateTokens(attachment);
  const compiled = {
    text: "not sent in multipart mode",
    multipart,
    images: [{ ref: "image-1", imageUrl: "data:image/png;base64,fixture", detail: "original" }],
    skillFiles: [{ name: "skill.txt", text: attachment }],
  };
  expect(tokens.measureCompiledChatGptWebInput(compiled, "gpt-5.6-sol")).toEqual({
    inputTokens:
      CHATGPT_WEB_PLATFORM_RESERVE_TOKENS +
      stageTokens +
      finalTokens +
      estimateTokens(stage.acknowledgement) +
      chatGptWebImageTokenReserve("original"),
    maxMessageTokens: Math.max(stageTokens, finalTokens),
    maxMessageChars: Math.max(stage.text.length, final.length),
  });
});

test("browser payload metrics exclude platform reserve and acknowledgements", () => {
  const compiled = {
    text: "not sent in multipart mode",
    multipart: {
      parts: ['{"records":[{"text":"first evidence"}]}', '{"records":[]}'],
      commit: "answer 😀",
    },
    images: [{ ref: "image-1", imageUrl: "data:image/png;base64,fixture", detail: "original" }],
    skillFiles: [{ name: "skill.txt", text: "stable instructions" }],
  };
  const messages = tokens.compiledChatGptWebMessages(compiled);
  const metric = tokens.measureCompiledBrowserPayload(compiled, "gpt-5.6-sol");
  expect(metric).toEqual({
    messageCount: 2,
    messageChars: messages.map((message) => message.length),
    messageBytes: messages.map((message) => Buffer.byteLength(message, "utf8")),
    messageTokensEstimated: messages.map((message) => estimateTokens(message, "gpt-5.6-sol")),
    skillFileCount: 1,
    skillFileBytes: Buffer.byteLength("stable instructions", "utf8"),
    skillFileTokensEstimated: estimateTokens("stable instructions", "gpt-5.6-sol"),
    imageCount: 1,
    imageTokensEstimated: chatGptWebImageTokenReserve("original"),
    cacheReadTokens: null,
  });
  expect(
    metric.messageTokensEstimated.reduce((sum: number, value: number) => sum + value, 0) +
      metric.skillFileTokensEstimated +
      metric.imageTokensEstimated,
  ).toBeLessThan(tokens.measureCompiledChatGptWebInput(compiled, "gpt-5.6-sol").inputTokens);
});

test("inline browser payload counts UTF-8 bytes separately from characters", () => {
  const compiled = { text: "Código 😀", images: [] };
  const metric = tokens.measureCompiledBrowserPayload(compiled, "gpt-5.6-sol");
  expect(metric.messageCount).toBe(1);
  expect(metric.messageChars).toEqual([compiled.text.length]);
  expect(metric.messageBytes).toEqual([Buffer.byteLength(compiled.text, "utf8")]);
  expect(metric.messageBytes[0]).toBeGreaterThan(metric.messageChars[0]);
  expect(metric.cacheReadTokens).toBeNull();
});

test("accepted multipart stage metrics charge images and skill files only to the final commit", () => {
  const compiled = {
    text: "unused",
    multipart: { parts: ['{"records":["first"]}', '{"records":["second"]}'], commit: "finish" },
    images: [{ ref: "image-1", imageUrl: "data:image/png;base64,fixture" }],
    skillFiles: [{ name: "skill.txt", text: "instructions" }],
  };
  const payload = tokens.measureCompiledBrowserPayload(compiled, "gpt-5.6-sol");
  const accepted = tokens.acceptedBrowserPayloadMetric;
  expect(accepted(payload, 0)).toMatchObject({
    stage: 1,
    stageCount: 2,
    skillFileCount: 0,
    imageCount: 0,
    cacheReadTokens: null,
  });
  expect(accepted(payload, 1)).toMatchObject({
    stage: 2,
    stageCount: 2,
    skillFileCount: 1,
    imageCount: 1,
    cacheReadTokens: null,
  });
  expect(() => accepted(payload, 2)).toThrow(RangeError);
  expect(JSON.stringify(accepted(payload, 0))).not.toContain("first");
});

test("context measurement reuses premeasured physical tokens without counting cache reads as headroom", () => {
  const compiled = {
    text: "Long context with emoji 😀".repeat(100),
    images: [{ ref: "image-1", imageUrl: "data:image/png;base64,fixture" }],
  };
  const payload = tokens.measureCompiledBrowserPayload(compiled, "gpt-5.6-sol");
  const standalone = tokens.measureCompiledChatGptWebInput(compiled, "gpt-5.6-sol");
  expect(tokens.measureCompiledChatGptWebInput(compiled, "gpt-5.6-sol", payload)).toEqual(standalone);
  expect(standalone.inputTokens).toBeGreaterThan(payload.messageTokensEstimated[0]!);
  expect(payload.cacheReadTokens).toBeNull();
});

test("browser payload observations appear only on acceptance and cannot duplicate a stage", () => {
  const payload = tokens.measureCompiledBrowserPayload({ text: "private task", images: [] }, "gpt-5.6-sol");
  const recorded: unknown[] = [];
  const accept = tokens.createBrowserPayloadAcceptanceRecorder(
    payload,
    { retainedConversation: true, compaction: false },
    (metric: unknown) => recorded.push(metric),
  );
  expect(recorded).toEqual([]);
  accept(0);
  accept(0);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ retainedConversation: true, compaction: false });
  expect(JSON.stringify(recorded)).not.toContain("private task");
  expect(() => accept(1)).toThrow(RangeError);
});

test("browser payload measurement uses exact staged messages selected for Send", () => {
  const compiled = {
    text: "unused",
    multipart: { parts: ['{"records":["one"]}', '{"records":["two"]}'], commit: "finish" },
    images: [],
  };
  const transactionId = `ctx_${"f".repeat(32)}`;
  const messages = [
    formatChatGptWebMultipartStage(compiled.multipart.parts[0]!, transactionId, 1, 2).text,
    formatChatGptWebMultipartCommit(compiled.multipart, transactionId),
  ];
  const measured = tokens.measureCompiledBrowserPayload(compiled, "gpt-5.6-sol", messages);
  expect(measured.messageBytes).toEqual(messages.map((message) => Buffer.byteLength(message, "utf8")));
  expect(measured.messageTokensEstimated).toEqual(messages.map((message) => estimateTokens(message, "gpt-5.6-sol")));
});

test("a failed telemetry sink cannot turn an accepted Send into a retry", () => {
  const payload = tokens.measureCompiledBrowserPayload({ text: "submit", images: [] }, "gpt-5.6-sol");
  let writes = 0;
  const accept = tokens.createBrowserPayloadAcceptanceRecorder(
    payload,
    { retainedConversation: false, compaction: false },
    () => {
      writes += 1;
      throw new Error("telemetry unavailable");
    },
  );
  expect(() => accept(0)).not.toThrow();
  expect(() => accept(0)).not.toThrow();
  expect(writes).toBe(1);
});
