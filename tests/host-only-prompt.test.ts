import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = "host_turn_01234567890123456789012345678901";

function request(hostOnly: boolean): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { systemPrompt: [], messages: [{ role: "user", content: "Inspect symbols", timestamp: 1 }] },
    stream: true,
    options: { reasoning: "high" },
    ...(hostOnly
      ? {
          _hostTurn: {
            sessionId: "host-session",
            turnId: "host-turn",
            environment: {
              execution: "host-only" as const,
              cwd: "/workspace",
              roots: [],
              writableRoots: [],
              sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
              tools: [],
            },
          },
        }
      : {}),
  };
}

for (const continuation of [false, true]) {
  test(`host-only contract is isolated from legacy cache with continuation=${continuation}`, () => {
    const options = { continuation };
    const legacy = compileChatGptWebPrompt(request(false), capabilities, token, options);
    const host = compileChatGptWebPrompt(request(true), capabilities, token, options);
    expect(legacy.text).toContain("prefer direct fast-path tools");
    expect(host.text).toContain("Use only codex_tool_inventory and codex_tool_call");
    expect(host.text).toContain("exact wire_name");
    expect(host.text).toContain("host owns execution, permissions, approvals, and cancellation");
    expect(host.text).not.toContain("prefer direct fast-path tools");
    expect(host.text).toContain("Do not use bridge-local filesystem handlers");
    expect(compileChatGptWebPrompt(request(false), capabilities, token, options).text).toBe(legacy.text);
    expect(compileChatGptWebPrompt(request(true), capabilities, token, options).text).toBe(host.text);
  });
}

test("authenticated Pi requests derive the user revision without native Codex item metadata", async () => {
  const { parseRequest } = await import("../src/responses/parser");
  const { extractChatGptTurnUserRevision } = await import("../src/adapters/chatgpt-web/environment");
  const parsed = parseRequest({
    model: "chatgpt-web/gpt-5.6-sol",
    input: [{ role: "user", content: [{ type: "input_text", text: "PI_WEB_OK" }] }],
  });
  parsed._hostTurn = {
    sessionId: "pi_session",
    turnId: "pi_turn",
    environment: { cwd: process.cwd(), execution: "host-only" } as any,
  };
  expect(extractChatGptTurnUserRevision(parsed)).toEqual([{ type: "input_text", text: "PI_WEB_OK" }]);
});
