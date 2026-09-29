import { describe, expect, test } from "bun:test";
import {
  CHAT_FIRST_MCP_INSTRUCTIONS,
  NATIVE_CHATGPT_MCP_INSTRUCTIONS,
} from "../src/adapters/chatgpt-web/mcp/instructions";
import type { ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

describe("Root-Level Zero Prompt Conditioning & MCP Access", () => {
  const baseCapabilities: ChatGptWebCapabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: false,
    proAvailable: false,
  };

  const createRequest = (verbosity: "low" | "medium" | "high" = "low"): CodexParsedRequest => ({
    modelId: "gpt-5.6-sol",
    stream: false,
    context: {
      messages: [
        {
          role: "user",
          content: "Explain how this architecture works in detail.",
          timestamp: 1,
        },
      ],
    },
    options: {
      verbosity,
    },
  });

  test("conversationalFreedom: true produces completely unconditioned prompt with pure MCP tool access", () => {
    const request = createRequest("low");
    const compiled = compileChatGptWebPrompt(request, baseCapabilities, "token-123", {
      conversationalFreedom: true,
    });

    // Zero forced brevity or verbosity conditioning
    expect(compiled.text).not.toContain("Codex requested low response verbosity");
    expect(compiled.text).not.toContain("Keep the final user-facing answer concise and direct");
    expect(compiled.text).not.toContain("Return only the answer that the outer Codex task should receive.");

    // Zero artificial freedom boilerplate conditioning
    expect(compiled.text).not.toContain("Maintain full conversational freedom");
    expect(compiled.text).not.toContain("formatted naturally with the depth and explanations requested by the user");
    expect(compiled.text).not.toContain("Return the complete answer that the outer Codex task should receive");

    // Pure MCP tool availability remains attached
    expect(compiled.text).toContain("codex_read_file");
    expect(compiled.text).toContain("codex_patch_file");
    expect(compiled.text).toContain("codex_write_file");
    expect(compiled.text).toContain("codex_list_dir");
    expect(compiled.text).toContain("codex_grep");
  });

  test("conversationalFreedom: false preserves legacy low verbosity constraint when requested", () => {
    const request = createRequest("low");
    const compiled = compileChatGptWebPrompt(request, baseCapabilities, "token-123", {
      conversationalFreedom: false,
    });

    // Legacy low verbosity text should be present
    expect(compiled.text).toContain("Codex requested low response verbosity");
    expect(compiled.text).toContain("Return only the answer that the outer Codex task should receive.");
    expect(compiled.text).not.toContain("Maintain full conversational freedom");
  });

  test("strict JSON-schema output format is enforced when explicitly requested", () => {
    const request: CodexParsedRequest = {
      modelId: "gpt-5.6-sol",
      stream: false,
      context: {
        messages: [{ role: "user", content: "Extract data", timestamp: 1 }],
      },
      options: {
        verbosity: "low",
        outputFormat: {
          type: "json_schema",
          name: "result_schema",
          strict: true,
          schema: { type: "object", properties: { key: { type: "string" } } },
        },
      },
    };

    const compiled = compileChatGptWebPrompt(request, baseCapabilities, "token-123", {
      conversationalFreedom: true,
    });

    // Strict schema contract must be preserved for structured output tasks
    expect(compiled.text).toContain('Codex requested a strict JSON-schema final answer named "result_schema"');
    expect(compiled.text).toContain("The final user-facing answer must be one JSON value matching the supplied schema");
  });

  test("MCP server instructions provide pure capability without conditioning text", () => {
    // Neither contract should contain conversational persona or brevity conditioning
    expect(NATIVE_CHATGPT_MCP_INSTRUCTIONS).not.toContain("conversational persona");
    expect(NATIVE_CHATGPT_MCP_INSTRUCTIONS).not.toContain("brevity, terseness");
    expect(CHAT_FIRST_MCP_INSTRUCTIONS).not.toContain("conversational persona");
    expect(CHAT_FIRST_MCP_INSTRUCTIONS).not.toContain("brevity, terseness");

    // Pure operational MCP instructions are present
    expect(CHAT_FIRST_MCP_INSTRUCTIONS).toContain("Chat-First contract");
    expect(CHAT_FIRST_MCP_INSTRUCTIONS).toContain("config.json");
    expect(NATIVE_CHATGPT_MCP_INSTRUCTIONS).toContain("Command execution remains owned by the outer host");
  });
});
