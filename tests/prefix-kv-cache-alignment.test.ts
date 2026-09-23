import { describe, expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};

function baseRequest(modelId = CHATGPT_WEB_MODEL_ID): CodexParsedRequest {
  return {
    modelId,
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: [
        "You are an AI programming assistant operating within Codex.",
        "Follow workspace safety guidelines and obey permission profiles.",
        "Preserve user instruction priority: system, developer, user.",
      ],
      messages: [
        { role: "user", content: "Initial user request: analyze the repository architecture.", timestamp: 1000 },
      ],
      tools: [
        {
          name: "exec_command",
          description: "Execute a command in workspace",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      ],
    },
  };
}

describe("Sprint K: Server-Side Prefix KV Cache Alignment", () => {
  test("Zero Risk prompts guarantee bit-for-bit identical static prefix before <codex_context_json>", () => {
    const req1 = baseRequest("chatgpt-web-zero-risk");
    const req2 = baseRequest("chatgpt-web-zero-risk");
    // Different request IDs representing successive turns
    const token1 = "request_11111111111111111111111111111111";
    const token2 = "request_22222222222222222222222222222222";

    const compiled1 = compileChatGptWebPrompt(req1, capabilities, token1, { manualControl: true });
    const compiled2 = compileChatGptWebPrompt(req2, capabilities, token2, { manualControl: true });

    // Find the boundary where <codex_context_json> begins
    const prefixEnd1 = compiled1.text.indexOf("<codex_context_json>");
    const prefixEnd2 = compiled2.text.indexOf("<codex_context_json>");

    expect(prefixEnd1).toBeGreaterThan(0);
    expect(prefixEnd1).toBe(prefixEnd2);

    const prefix1 = compiled1.text.slice(0, prefixEnd1);
    const prefix2 = compiled2.text.slice(0, prefixEnd2);

    // Prefix must be 100% byte-for-byte identical
    expect(prefix1).toBe(prefix2);

    // Volatile token must NOT be present in the static prefix
    expect(prefix1).not.toContain(token1);
    expect(prefix1).not.toContain("request_id");
    expect(prefix1).not.toContain("<codex_zero_risk_request_json>");

    // Volatile token must be quarantined strictly after </codex_context_json>
    const contextEnd1 = compiled1.text.indexOf("</codex_context_json>");
    const zeroRiskPos1 = compiled1.text.indexOf("<codex_zero_risk_request_json>");
    expect(zeroRiskPos1).toBeGreaterThan(contextEnd1);
  });

  test("Full Mode prompts guarantee bit-for-bit identical static prefix before <codex_context_json>", () => {
    const req1 = baseRequest(CHATGPT_WEB_MODEL_ID);
    const req2 = baseRequest(CHATGPT_WEB_MODEL_ID);
    const token1 = "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const token2 = "turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const compiled1 = compileChatGptWebPrompt(req1, capabilities, token1);
    const compiled2 = compileChatGptWebPrompt(req2, capabilities, token2);

    const prefixEnd1 = compiled1.text.indexOf("<codex_context_json>");
    const prefixEnd2 = compiled2.text.indexOf("<codex_context_json>");

    expect(prefixEnd1).toBeGreaterThan(0);
    expect(prefixEnd1).toBe(prefixEnd2);

    const prefix1 = compiled1.text.slice(0, prefixEnd1);
    const prefix2 = compiled2.text.slice(0, prefixEnd2);

    expect(prefix1).toBe(prefix2);
    expect(prefix1).not.toContain(token1);
    expect(prefix1).not.toContain("turn_token");

    // Turn token is strictly confined to the trailing transport resume
    const contextEnd1 = compiled1.text.indexOf("</codex_context_json>");
    const resumePos1 = compiled1.text.indexOf("<codex_transport_resume>");
    expect(resumePos1).toBeGreaterThan(contextEnd1);
  });

  test("Incremental multi-turn prompt retains common prefix up to new message", () => {
    const reqTurn1 = baseRequest(CHATGPT_WEB_MODEL_ID);
    const reqTurn2 = baseRequest(CHATGPT_WEB_MODEL_ID);
    reqTurn2.context.messages.push(
      { role: "assistant", content: [{ type: "text", text: "I have analyzed the architecture." }], timestamp: 2000 },
      { role: "user", content: "Proceed with the test plan.", timestamp: 3000 },
    );

    const token1 = "turn_turn1_111111111111111111111111";
    const token2 = "turn_turn2_222222222222222222222222";

    const compiled1 = compileChatGptWebPrompt(reqTurn1, capabilities, token1);
    const compiled2 = compileChatGptWebPrompt(reqTurn2, capabilities, token2);

    // Compute common leading prefix length
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < compiled1.text.length &&
      commonPrefixLength < compiled2.text.length &&
      compiled1.text[commonPrefixLength] === compiled2.text[commonPrefixLength]
    ) {
      commonPrefixLength++;
    }

    const commonPrefix = compiled1.text.slice(0, commonPrefixLength);

    // The common prefix MUST cover:
    // 1. All static contracts
    // 2. <codex_context_json> tag
    // 3. The version and systemPrompt
    // 4. The first user message
    expect(commonPrefix).toContain("Act as the model backend for the Codex task");
    expect(commonPrefix).toContain("<codex_context_json>");
    expect(commonPrefix).toContain("\"version\":3");
    expect(commonPrefix).toContain("You are an AI programming assistant operating within Codex");
    expect(commonPrefix).toContain("Initial user request: analyze the repository architecture");

    // Common prefix must be substantial (> 2000 characters) to ensure OpenAI KV cache hit
    expect(commonPrefixLength).toBeGreaterThan(2000);
  });

  test("Volatile elements never precede static contracts or context envelope", () => {
    const req = baseRequest("chatgpt-web-zero-risk");
    const token = "request_volatile_token_test_123456";
    const compiled = compileChatGptWebPrompt(req, capabilities, token, { manualControl: true });

    const contextJsonStart = compiled.text.indexOf("<codex_context_json>");
    const contextJsonEnd = compiled.text.indexOf("</codex_context_json>");
    const zeroRiskJsonStart = compiled.text.indexOf("<codex_zero_risk_request_json>");

    // Invariant: static contracts -> <codex_context_json> ... </codex_context_json> -> <codex_zero_risk_request_json>
    expect(contextJsonStart).toBeGreaterThan(0);
    expect(contextJsonEnd).toBeGreaterThan(contextJsonStart);
    expect(zeroRiskJsonStart).toBeGreaterThan(contextJsonEnd);
  });
});
