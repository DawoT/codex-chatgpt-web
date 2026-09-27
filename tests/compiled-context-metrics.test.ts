import { expect, test } from "bun:test";
import * as tokens from "../src/adapters/chatgpt-web/input-tokens";
import { compileChatGptWebPrompt, formatChatGptWebMultipartStage, formatChatGptWebMultipartCommit } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../src/chatgpt-web-models";
import { estimateTokens } from "../src/lib/token-estimate";

test("combined compiled metrics retain inline text and platform budgets", () => {
  const compiled = compileChatGptWebPrompt({
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    context: { messages: [{ role: "user", content: "Preserve the evidence 😀", timestamp: 1 }] },
  }, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });
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
    inputTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + stageTokens + finalTokens
      + estimateTokens(stage.acknowledgement) + chatGptWebImageTokenReserve("original"),
    maxMessageTokens: Math.max(stageTokens, finalTokens),
    maxMessageChars: Math.max(stage.text.length, final.length),
  });
});
