import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";

test("ordinary compiled prompts retain old failed tool evidence and its exact source reference", () => {
  const evidence =
    "diagnostic line\n".repeat(1000) +
    "UNRESOLVED: migration uncertain; never replay. Source src/db.ts:40 revision abc123.";
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    context: {
      messages: [
        { role: "user", content: "Audit without deployment", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "old-call",
          toolName: "exec",
          content: evidence,
          isError: true,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "recent-1",
          toolName: "read",
          content: "latest evidence one",
          isError: false,
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: "recent-2",
          toolName: "read",
          content: "latest evidence two",
          isError: false,
          timestamp: 4,
        },
        { role: "user", content: "Explain the original failure", timestamp: 5 },
      ],
    },
  };
  const original = structuredClone(request);
  const compiled = compileChatGptWebPrompt(request, {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  });
  expect(compiled.text).toContain(JSON.stringify(evidence).slice(1, -1));
  expect(compiled.text).toContain("old-call");
  expect(compiled.text).toContain("Audit without deployment");
  expect(request).toEqual(original);
});

test("oversized automatic compaction stages the complete history within the base window", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: {
      messages: [
        { role: "user", content: `Pending obligation: ${"evidence ".repeat(20000)}`, timestamp: 1 },
        { role: "user", content: "Produce the checkpoint", timestamp: 2 },
      ],
    },
  };
  const original = structuredClone(request);
  const compiled = compileChatGptWebPrompt(request, {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  });
  expect(compiled.multipart?.parts).toHaveLength(6);
  const records = compiled.multipart!.parts.flatMap((part) => JSON.parse(part).records);
  expect(records.map((record) => record.message.content)).toEqual(
    request.context.messages.map((message) => message.content),
  );
  expect(request).toEqual(original);
});

test("multipart compaction retains the checkpoint, failed output and image evidence", () => {
  const evidence = "failed operation evidence ".repeat(6000);
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: {
      messages: [
        { role: "user", content: "Checkpoint: deployment forbidden; migration unresolved.", timestamp: 1 },
        { role: "toolResult", toolCallId: "failed", toolName: "exec", isError: true, content: evidence, timestamp: 2 },
        {
          role: "user",
          content: [
            { type: "text", text: "Screenshot of the failure" },
            { type: "image", imageUrl: "data:image/png;base64,evidence" },
          ],
          timestamp: 3,
        },
        { role: "user", content: "Produce the checkpoint", timestamp: 4 },
      ],
    },
  };
  const compiled = compileChatGptWebPrompt(
    request,
    {
      localToolsEnabled: false,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
    },
    undefined,
    { experimentalMultipartParts: 6 },
  );
  const records = compiled.multipart!.parts.flatMap((part) => JSON.parse(part).records);
  expect(records.map((record) => record.message_index)).toEqual([0, 1, 2, 3]);
  expect(records[0].message.content).toContain("deployment forbidden");
  expect(records[1].message.content).toBe(evidence);
  expect(compiled.images.map((image) => image.imageUrl)).toEqual(["data:image/png;base64,evidence"]);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
});

test("automatic staging cannot multiply the base model context window", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: { reasoning: "high" },
    _compactionRequest: true,
    context: {
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: "user" as const,
        content: "word ".repeat(15000),
        timestamp: index + 1,
      })),
    },
  };
  expect(() =>
    compileChatGptWebPrompt(request, {
      localToolsEnabled: false,
      solAvailable: true,
      extraHighAvailable: false,
      proAvailable: false,
    }),
  ).toThrow("base model context window");
});

test("manual compaction never automatically stages browser messages", () => {
  const request: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: { messages: [{ role: "user", content: "evidence ".repeat(20000), timestamp: 1 }] },
  };
  expect(() =>
    compileChatGptWebPrompt(
      request,
      {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: true,
      },
      "turn_12345678901234567890123456789012",
      { manualControl: true },
    ),
  ).toThrow("complete history");
});

test("manual compaction rejects an explicit multipart request until the launcher supports several sends", () => {
  const request: CodexParsedRequest = {
    modelId: "chatgpt-web-zero-risk",
    stream: false,
    options: {},
    _compactionRequest: true,
    context: { messages: [{ role: "user", content: "Continue the task", timestamp: 1 }] },
  };

  expect(() =>
    compileChatGptWebPrompt(
      request,
      {
        localToolsEnabled: true,
        solAvailable: false,
        extraHighAvailable: false,
        proAvailable: false,
      },
      "turn_12345678901234567890123456789012",
      {
        manualControl: true,
        experimentalMultipartParts: 6,
      },
    ),
  ).toThrow("does not support rolling or multipart browser transport");
});
