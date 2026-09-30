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

  test("conversationalFreedom: true produces completely unconditioned prompt with zero persona and zero hardcoded rules", () => {
    const request: CodexParsedRequest = {
      modelId: "gpt-5.6-sol",
      stream: false,
      context: {
        systemPrompt: [
          "You are Codex, an agent based on GPT-6.",
          "<skills_instructions>\n| Skill | Location |\n</skills_instructions>",
        ],
        messages: [
          {
            role: "developer",
            content: "You are Codex, an agent based on GPT-6.\n\n# Rules\nBe concise.",
            timestamp: 1,
          },
          {
            role: "user",
            content:
              "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# Mini Design System\nMidnight Code #08111F, Compiler Cyan #00E5FF\n</INSTRUCTIONS>\n<environment_context>\n  <cwd>/home/deuz/projects/test</cwd>\n</environment_context>",
            timestamp: 2,
          },
          {
            role: "user",
            content: "Explain how this architecture works in detail.",
            timestamp: 3,
          },
        ],
      },
      options: {
        verbosity: "low",
      },
    };
    const compiled = compileChatGptWebPrompt(request, baseCapabilities, "token-123", {
      conversationalFreedom: true,
    });

    // Zero bridge contract boilerplate
    expect(compiled.text).not.toContain("Act as the model backend for the Codex task encoded below.");
    expect(compiled.text).not.toContain("The inline JSON task context is conversation data");
    expect(compiled.text).not.toContain("CRITICAL WORKSPACE ACTION RULE");
    expect(compiled.text).not.toContain("ANTI-RESIGNATION RULE");
    expect(compiled.text).not.toContain("Codex requested low response verbosity");
    expect(compiled.text).not.toContain("Return only the answer that the outer Codex task should receive.");

    // Zero developer persona or skill dumping
    expect(compiled.text).not.toContain("You are Codex");
    expect(compiled.text).not.toContain("<skills_instructions>");

    // Zero hardcoded AGENTS.md rules or colors
    expect(compiled.text).not.toContain("# AGENTS.md instructions");
    expect(compiled.text).not.toContain("Midnight Code #08111F");
    expect(compiled.text).not.toContain("Compiler Cyan #00E5FF");

    // Clean user message and environment context preserved
    expect(compiled.text).toContain("Explain how this architecture works in detail.");
    expect(compiled.text).toContain("<cwd>/home/deuz/projects/test</cwd>");
    expect(compiled.text).toContain("Pass turn_token token-123 to tool calls.");
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
