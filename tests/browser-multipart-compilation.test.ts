import { expect, test } from "bun:test";
import { assertChatGptWebMultipartInputWithinLimits } from "../src/adapters/chatgpt-web/browser/staging-limits";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  compileChatGptWebPrompt,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
} from "../src/adapters/chatgpt-web/prompt";
import { estimateTokens } from "../src/lib/token-estimate";

test("Bigger Context rejects mixed-density records that exceed the safe browser boundary", () => {
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
    experimentalBiggerContext: true,
  };
  const dense = "a!b@c#d$e%f^g&h*".repeat(3_750);
  const sparse = "x".repeat(dense.length);
  const whitespace = " ".repeat(450_000);
  // Equal byte sizes must not pack two dense records into one oversized stage. Conversely,
  // token-only balancing must not leave all the low-token whitespace in one oversized composer.
  for (const contents of [
    [dense, dense, sparse, sparse, dense, sparse],
    [dense, dense, whitespace, whitespace, whitespace, whitespace],
  ]) {
    const compiled = compileChatGptWebPrompt(
      {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" },
        _compactionRequest: true,
        context: {
          systemPrompt: [],
          messages: contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 })),
        },
      },
      capabilities,
      undefined,
      { experimentalMultipartParts: 6 },
    );
    const multipart = compiled.multipart!;
    const records = multipart.parts.flatMap((part) => JSON.parse(part).records);
    expect(records).toEqual(
      contents.map((content, message_index) => ({
        kind: "message",
        message_index,
        message: { role: "user", content },
      })),
    );
    expect(compiled.trimmedCompactionMessages).toBeUndefined();

    const transaction = "ctx_0123456789abcdef0123456789abcdef";
    const stages = multipart.parts
      .slice(0, -1)
      .map((payload, index) => formatChatGptWebMultipartStage(payload, transaction, index + 1, 6).text);
    const final = formatChatGptWebMultipartCommit(multipart, transaction);
    const maxStageMessageTokens = Math.max(...stages.map((text) => estimateTokens(text)));
    const maxStageChars = Math.max(...stages.map((text) => text.length));
    const finalMessageTokens = estimateTokens(final);
    expect(() =>
      assertChatGptWebMultipartInputWithinLimits(
        estimateCompiledChatGptWebInputTokens(compiled, CHATGPT_WEB_MODEL_ID),
        Math.max(maxStageMessageTokens, finalMessageTokens),
        CHATGPT_WEB_MODEL_ID,
        "high",
        capabilities,
        Math.max(maxStageChars, final.length),
        6,
        {
          stagingEffort: "medium",
          maxStageMessageTokens,
          maxStageChars,
          finalMessageTokens,
          finalMessageChars: final.length,
        },
      ),
    ).toThrow("45,000");
  }
}, 90_000);
